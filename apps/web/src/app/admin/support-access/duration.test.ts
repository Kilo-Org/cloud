import { describe, expect, test } from '@jest/globals';
import { maxSupportDurationMinutes, parseSupportDurationMinutes } from './duration';

describe('support access duration input', () => {
  test.each([
    ['', undefined],
    ['30', 30],
    ['60', 60],
    ['120', 60],
  ] as const)('read "%s" becomes %s minutes', (raw, minutes) => {
    expect(parseSupportDurationMinutes(raw, 'support_read')).toEqual({
      valid: true,
      minutes,
    });
  });

  test.each([
    ['15', 15],
    ['60', 15],
  ] as const)('write "%s" clamps to %s minutes', (raw, minutes) => {
    expect(parseSupportDurationMinutes(raw, 'support_write')).toEqual({
      valid: true,
      minutes,
    });
  });

  test.each(['0', '-5', 'NaN', '1.5'])('rejects %s', raw => {
    expect(parseSupportDurationMinutes(raw, 'support_read')).toMatchObject({ valid: false });
  });

  test('caps are the same values the policy enforces', () => {
    expect(maxSupportDurationMinutes('support_read')).toBe(60);
    expect(maxSupportDurationMinutes('support_write')).toBe(15);
  });
});
