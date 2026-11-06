import { describe, expect, it } from 'vitest';

import { isAddressableStoredSessionId, isPlausibleKiloSessionId } from './session-id-shape';

describe('isPlausibleKiloSessionId', () => {
  it('accepts the shape every real Kilo session id takes', () => {
    // 30 chars: `ses_` + 26.
    expect(isPlausibleKiloSessionId('ses_12345678901234567890123456')).toBe(true);
  });

  it.each([
    ['the all-zeros UUID the explorer observed', '00000000-0000-0000-0000-000000000000'],
    ['a bare segment with no prefix', 'new'],
    ['a short id', 'ses_123'],
    ['a 30-char value with the wrong prefix', 'xyz_12345678901234567890123456'],
    ['a 29-char id', 'ses_1234567890123456789012345'],
    ['a 31-char id', 'ses_123456789012345678901234567'],
    ['an empty string', ''],
  ])('rejects %s', (_name, value) => {
    expect(isPlausibleKiloSessionId(value)).toBe(false);
  });
});

describe('isAddressableStoredSessionId', () => {
  it.each([
    ['a canonical id', 'ses_12345678901234567890123456'],
    ['an id minted before the canonical shape', 'xmw2l780h18'],
    ['a stored UUID id', '0b6f5a9e-9a0e-4dbb-9a4a-2a0d9c6f5e11'],
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
