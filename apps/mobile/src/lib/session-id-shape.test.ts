import { describe, expect, it } from 'vitest';

import { isPlausibleKiloSessionId } from './session-id-shape';

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
