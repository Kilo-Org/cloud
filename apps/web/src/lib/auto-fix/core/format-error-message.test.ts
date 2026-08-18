import {
  AUTO_FIX_INSUFFICIENT_CREDITS_MESSAGE,
  formatAutoFixErrorMessage,
  isAutoFixBillingErrorMessage,
} from './format-error-message';

describe('formatAutoFixErrorMessage', () => {
  it('maps raw initiate 402 payloads to a clear credits message', () => {
    const raw =
      'initiateFromKilocodeSessionV2 failed (402): {"error":{"message":"Insufficient credits: $1 minimum required","code":-32002,"data":{"code":"PAYMENT_REQUIRED","httpStatus":402}}}';

    expect(formatAutoFixErrorMessage(raw)).toBe(AUTO_FIX_INSUFFICIENT_CREDITS_MESSAGE);
  });

  it('maps short insufficient-credits text', () => {
    expect(formatAutoFixErrorMessage('Insufficient credits: $1 minimum required')).toBe(
      AUTO_FIX_INSUFFICIENT_CREDITS_MESSAGE
    );
  });

  it('leaves unrelated errors unchanged', () => {
    expect(formatAutoFixErrorMessage('Failed to get PR config: 500 - boom')).toBe(
      'Failed to get PR config: 500 - boom'
    );
  });

  it('does not treat generic "minimum required" text as a billing error', () => {
    const raw = 'Sandbox image node20 is the minimum required version';
    expect(formatAutoFixErrorMessage(raw)).toBe(raw);
  });

  it('handles empty input', () => {
    expect(formatAutoFixErrorMessage('   ')).toBe('Unknown error');
  });
});

describe('isAutoFixBillingErrorMessage', () => {
  it('detects payment_required codes in dumped JSON', () => {
    expect(isAutoFixBillingErrorMessage('{"data":{"code":"PAYMENT_REQUIRED"}}')).toBe(true);
  });

  it('returns false for non-billing errors', () => {
    expect(isAutoFixBillingErrorMessage('timeout waiting for sandbox')).toBe(false);
  });
});
