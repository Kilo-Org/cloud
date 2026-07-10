import { describe, expect, it } from 'vitest';
import {
  parseAuthErrorCode,
  parseEmailCodeResponse,
  parseTokenResponse,
} from './auth/native-auth-contract';

describe('native auth response contracts', () => {
  it('accepts valid token and email-code responses', () => {
    expect(parseTokenResponse({ token: 'token-value' })).toEqual({ token: 'token-value' });
    expect(parseEmailCodeResponse({ success: true })).toEqual({ success: true });
  });

  it.each([undefined, null, {}, { token: 1 }, { token: '' }])(
    'rejects malformed token response %j',
    value => {
      expect(parseTokenResponse(value)).toBeNull();
    }
  );

  it.each([undefined, null, {}, { success: false }, { success: 'true' }])(
    'rejects malformed email-code response %j',
    value => {
      expect(parseEmailCodeResponse(value)).toBeNull();
    }
  );

  it('extracts only string error codes', () => {
    expect(parseAuthErrorCode({ error: 'SSO_ERROR' })).toBe('SSO_ERROR');
    expect(parseAuthErrorCode({ error: 500 })).toBeUndefined();
    expect(parseAuthErrorCode(null)).toBeUndefined();
  });
});
