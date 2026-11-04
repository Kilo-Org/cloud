import {
  buildMessageId,
  isCanonicalMessageId,
  MESSAGE_ID_RANDOM_LENGTH,
} from '@kilocode/session-ingest-contracts/message-id';
import { generateMessageId } from './message-id';

describe('generateMessageId', () => {
  it('returns an id the contract validator accepts', () => {
    expect(isCanonicalMessageId(generateMessageId())).toBe(true);
  });

  it('hands the contract builder exactly the random bytes a canonical id needs', () => {
    const now = 1_700_000_000_000;
    const canonical = new Uint8Array(MESSAGE_ID_RANDOM_LENGTH).fill(0xff);

    expect(isCanonicalMessageId(buildMessageId(now, canonical))).toBe(true);
    for (const length of [0, MESSAGE_ID_RANDOM_LENGTH - 1, MESSAGE_ID_RANDOM_LENGTH + 1]) {
      expect(() => buildMessageId(now, new Uint8Array(length))).toThrow(/random bytes/);
    }
  });
});
