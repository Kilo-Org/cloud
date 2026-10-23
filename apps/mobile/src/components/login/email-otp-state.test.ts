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

  it('accepts a code typed in the digits of its script', () => {
    expect(canSubmitEmailCode('٢٤٦٨١٠')).toBe(true);
    expect(canSubmitEmailCode('۲۴۶۸۱۰')).toBe(true);
    expect(canSubmitEmailCode('२४६८१०')).toBe(true);
    expect(canSubmitEmailCode('২৪৬৮১০')).toBe(true);
    expect(canSubmitEmailCode('๒๔๖๘๑๐')).toBe(true);
  });

  it('accepts a code that mixes ASCII and native digits', () => {
    expect(canSubmitEmailCode('٢٤6٨๑0')).toBe(true);
  });

  it('keeps rejecting a native-digit code that is not six digits', () => {
    expect(canSubmitEmailCode('٢٤٦٨١')).toBe(false);
    expect(canSubmitEmailCode('٢٤٦٨١00')).toBe(false);
  });
});
