/**
 * Tests for findings #9 (cert digest enforcement) and #12 (simulator bypass
 * production guard) from the C14 enforce review.
 */
import { describe, test, expect } from '@jest/globals';
import { isProductionInternal, verifyPlayIntegrity } from './native-admission-google';

// ── Simulator bypass production guard (finding #12) ──────────────────────

describe('isProductionInternal (internal guard)', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('returns false in test environment', () => {
    expect(isProductionInternal()).toBe(false);
  });

  test('returns true when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    expect(isProductionInternal()).toBe(true);
  });
});

describe('verifyPlayIntegrity production bypass guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBypass = process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalBypass === undefined) {
      delete process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS;
    } else {
      process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS = originalBypass;
    }
  });

  test('bypass is NOT taken in production even with NATIVE_ADMISSION_SIMULATOR_BYPASS=true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS = 'true';

    // In production with bypass=true and no credentials configured,
    // verifyPlayIntegrity must throw (fail-closed), NOT return the
    // simulator bypass result.
    await expect(verifyPlayIntegrity('fake-token', 'fake-challenge')).rejects.toThrow(
      'Google Play Integrity credentials not configured'
    );
  });

  test('bypass is taken in non-production with NATIVE_ADMISSION_SIMULATOR_BYPASS=true', async () => {
    process.env.NODE_ENV = 'development';
    process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS = 'true';

    const result = await verifyPlayIntegrity('fake-token', 'fake-challenge');
    expect(result).toEqual({ ok: true, packageName: 'com.example.simulator' });
  });
});
