import { describe, expect, it } from 'vitest';
import { canSubmitEmailCode } from './email-otp-state';

describe('canSubmitEmailCode', () => {
  it.each(['', '1', '12345', '12345a', '1234567'])('rejects %j', code => {
    expect(canSubmitEmailCode(code, 'en')).toBe(false);
  });

  it('accepts exactly six digits when no auth action is busy', () => {
    expect(canSubmitEmailCode('123456', 'en')).toBe(true);
    expect(canSubmitEmailCode('123456', 'en', 'otp-send')).toBe(false);
    expect(canSubmitEmailCode('123456', 'en', 'otp-verify')).toBe(false);
  });

  it('accepts a code typed in the digits of its script', () => {
    expect(canSubmitEmailCode('٢٤٦٨١٠', 'ar')).toBe(true);
    expect(canSubmitEmailCode('۲۴۶۸۱۰', 'fa')).toBe(true);
    expect(canSubmitEmailCode('२४६८१०', 'hi')).toBe(true);
    expect(canSubmitEmailCode('২৪৬৮১০', 'bn')).toBe(true);
  });

  it('accepts a code that mixes ASCII and native digits', () => {
    expect(canSubmitEmailCode('٢٤6٨١0', 'ar')).toBe(true);
  });

  it('keeps rejecting a native-digit code that is not six digits', () => {
    expect(canSubmitEmailCode('٢٤٦٨١', 'ar')).toBe(false);
    expect(canSubmitEmailCode('٢٤٦٨١00', 'ar')).toBe(false);
  });
});
