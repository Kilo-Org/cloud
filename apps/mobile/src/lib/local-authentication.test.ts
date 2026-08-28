import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LocalAuthenticationError,
  type LocalAuthenticationOptions,
  type LocalAuthenticationResult,
  type SecurityLevel,
} from 'expo-local-authentication';

import { authenticateLocalAccess } from './local-authentication';

const native = vi.hoisted(() => ({
  getEnrolledLevelAsync: vi.fn<() => Promise<SecurityLevel>>(),
  authenticateAsync:
    vi.fn<(options?: LocalAuthenticationOptions) => Promise<LocalAuthenticationResult>>(),
}));
vi.mock('expo-local-authentication', () => ({
  ...native,
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

beforeEach(() => {
  native.getEnrolledLevelAsync.mockReset().mockResolvedValue(3);
  native.authenticateAsync.mockReset().mockResolvedValue({ success: true });
});

describe('native device-owner authentication', () => {
  it.each([1, 2, 3] as const)(
    'authenticates level %s with compatible native fallback',
    async level => {
      native.getEnrolledLevelAsync.mockResolvedValue(level);
      native.authenticateAsync.mockImplementation(async options => {
        const result: LocalAuthenticationResult = await Promise.resolve(
          options?.disableDeviceFallback === false &&
            options.biometricsSecurityLevel === undefined &&
            options.promptMessage === 'Unlock this account'
            ? { success: true }
            : { success: false, error: 'not_available' }
        );
        return result;
      });
      expect(await authenticateLocalAccess('Unlock this account')).toEqual({
        status: 'authenticated',
      });
    }
  );

  it('does not treat capability as authentication', async () => {
    const prompt = Promise.withResolvers<LocalAuthenticationResult>();
    native.authenticateAsync.mockReturnValue(prompt.promise);
    const result = authenticateLocalAccess('Unlock');
    prompt.resolve({ success: false, error: 'authentication_failed' });
    expect(await result).toEqual({ status: 'retryable', reason: 'authentication_failed' });
  });

  it('rechecks removed enrollment and accepts a newly authenticated device owner', async () => {
    native.getEnrolledLevelAsync
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    expect(await authenticateLocalAccess('Unlock')).toEqual({ status: 'authenticated' });
    expect(await authenticateLocalAccess('Unlock')).toEqual({
      status: 'unavailable',
      reason: 'not_enrolled',
    });
    expect(await authenticateLocalAccess('Unlock')).toEqual({ status: 'authenticated' });
  });

  it.each([
    ['not_enrolled', 'unavailable'],
    ['user_cancel', 'retryable'],
    ['app_cancel', 'retryable'],
    ['not_available', 'unavailable'],
    ['lockout', 'retryable'],
    ['no_space', 'terminal'],
    ['timeout', 'retryable'],
    ['unable_to_process', 'retryable'],
    ['unknown', 'retryable'],
    ['system_cancel', 'retryable'],
    ['user_fallback', 'retryable'],
    ['invalid_context', 'terminal'],
    ['passcode_not_set', 'unavailable'],
    ['authentication_failed', 'retryable'],
    ['missing_usage_description', 'terminal'],
  ] as const)('protects %s with %s recovery', async (reason, status) => {
    // Expo's native implementation also returns missing_usage_description, outside its declared union.
    native.authenticateAsync.mockResolvedValue({
      success: false,
      error: reason as LocalAuthenticationError,
    });
    expect(await authenticateLocalAccess('Unlock')).toEqual({ status, reason });
  });

  it.each(['getEnrolledLevelAsync', 'authenticateAsync'] as const)(
    'protects a rejected %s promise',
    async method => {
      native[method].mockRejectedValue(new Error('Native failure'));
      expect(await authenticateLocalAccess('Unlock')).toEqual({
        status: 'retryable',
        reason: 'rejected',
      });
    }
  );

  it('does not expose unknown native error text or grant access', async () => {
    native.authenticateAsync.mockResolvedValue({
      success: false,
      error: 'unknown: native detail' as LocalAuthenticationError,
    });
    expect(await authenticateLocalAccess('Unlock')).toEqual({
      status: 'terminal',
      reason: 'unexpected_error',
    });
  });
});
