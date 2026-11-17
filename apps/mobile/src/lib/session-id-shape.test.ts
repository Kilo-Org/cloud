import { describe, expect, it } from 'vitest';

import { isAddressableStoredSessionId } from './session-id-shape';

describe('isAddressableStoredSessionId', () => {
  it.each([
    ['a canonical id', 'ses_12345678901234567890123456'],
    ['an id minted before the canonical shape', 'xmw2l780h18'],
    ['a stored UUID id', '0b6f5a9e-9a0e-4dbb-9a4a-2a0d9c6f5e11'],
    ['a ses_ id whose length drifted from the canonical shape', 'ses_01J9FRESH000000000000000001'],
    ['the composer capture the session route owns', 'new'],
    ['the longest allowed id', 'a'.repeat(255)],
  ])('accepts %s', (_name, value) => {
    expect(isAddressableStoredSessionId(value)).toBe(true);
  });

  it.each([
    ['an empty param', ''],
    ['an id past the length bound', 'a'.repeat(256)],
    ['a segment with a slash', 'ses_123/other'],
    ['a segment with a space', 'ses_123 456'],
    ['a segment with a NUL', 'ses_123\u0000456'],
  ])('rejects %s', (_name, value) => {
    expect(isAddressableStoredSessionId(value)).toBe(false);
  });
});
