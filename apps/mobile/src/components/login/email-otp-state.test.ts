import { describe, expect, it } from 'vitest';
import { canSubmitEmailCode } from './email-otp-state';

describe('canSubmitEmailCode', () => {
  it.each(['', '1', '12345', '12345a', '1234567'])('rejects %j', code => {
    expect(canSubmitEmailCode(code)).toBe(false);
  });

  it('accepts exactly six digits when no auth action is busy', () => {
    expect(canSubmitEmailCode('123456')).toBe(true);
    expect(canSubmitEmailCode('123456', 'otp-send')).toBe(false);
    expect(canSubmitEmailCode('123456', 'otp-verify')).toBe(false);
  });
});
