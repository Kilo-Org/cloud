import { describe, expect, it } from 'vitest';

import { decodeConversationCursor, encodeConversationCursor } from '../src/utils';

const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('conversation cursor helpers', () => {
  it('round-trips a valid conversation cursor', () => {
    const cursor = { t: 1_700_000_000_000, c: VALID_ULID };

    expect(decodeConversationCursor(encodeConversationCursor(cursor))).toEqual(cursor);
  });

  it('rejects cursors with negative timestamps', () => {
    const encoded = encodeConversationCursor({ t: -1, c: VALID_ULID });

    expect(decodeConversationCursor(encoded)).toBeNull();
  });

  it('rejects cursors with non-ULID tie-breakers', () => {
    const encoded = encodeConversationCursor({ t: 1_700_000_000_000, c: 'not-a-ulid' });

    expect(decodeConversationCursor(encoded)).toBeNull();
  });
});
