/**
 * Tests for findings #9 (cert digest enforcement), #12 (simulator bypass
 * production guard), and the Play Integrity decode endpoint fix (the resource
 * path must carry the configured package name, not the project number).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { isProductionInternal, verifyPlayIntegrity } from './native-admission-google';

// Values are read lazily (via getters) so tests can vary the configuration.
const mockConfig = {
  GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME: 'com.kilocode.kiloapp',
  GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER: '123456789',
  GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: '',
  GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS: 'test-cert-digest',
};

jest.mock('@/lib/config.server', () => ({
  get GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME() {
    return mockConfig.GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME;
  },
  get GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER() {
    return mockConfig.GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER;
  },
  get GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY() {
    return mockConfig.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY;
  },
  get GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS() {
    return mockConfig.GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS;
  },
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

// ── Simulator bypass production guard (finding #12) ──────────────────────

describe('isProductionInternal (internal guard)', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalEnv,
      writable: false,
    });
  });

  test('returns false in test environment', () => {
    expect(isProductionInternal()).toBe(false);
  });

  test('returns true when NODE_ENV is production', () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'production',
      writable: false,
    });
    expect(isProductionInternal()).toBe(true);
  });
});

describe('verifyPlayIntegrity production bypass guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBypass = process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS;

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalNodeEnv,
      writable: false,
    });
    if (originalBypass === undefined) {
      delete process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS;
    } else {
      process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS = originalBypass;
    }
  });

  test('bypass is NOT taken in production even with NATIVE_ADMISSION_SIMULATOR_BYPASS=true', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'production',
      writable: false,
    });
    process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS = 'true';

    // In production with bypass=true and no credentials configured,
    // verifyPlayIntegrity must throw (fail-closed), NOT return the
    // simulator bypass result.
    await expect(verifyPlayIntegrity('fake-token', 'fake-challenge')).rejects.toThrow(
      'Google Play Integrity credentials not configured'
    );
  });

  test('bypass is taken in non-production with NATIVE_ADMISSION_SIMULATOR_BYPASS=true', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'development',
      writable: false,
    });
    process.env.NATIVE_ADMISSION_SIMULATOR_BYPASS = 'true';

    const result = await verifyPlayIntegrity('fake-token', 'fake-challenge');
    expect(result).toEqual({ ok: true, packageName: 'com.example.simulator' });
  });
});

// ── Decode endpoint resource path ─────────────────────────────────────────

describe('verifyPlayIntegrity decode endpoint', () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeAll(() => {
    // getAccessToken signs a real JWT, so the service account key needs a
    // valid RSA private key.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    mockConfig.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY = JSON.stringify({
      client_email: 'play-integrity@example.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: 'https://oauth2.googleapis.com/token',
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('calls decodeIntegrityToken with the configured package name in the resource path', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    });
    const expectedNonce = createHash('sha256').update('challenge-value').digest('base64');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tokenPayloadExternal: {
          requestDetails: {
            requestPackageName: 'com.kilocode.kiloapp',
            nonce: expectedNonce,
          },
          appIntegrity: {
            appRecognitionVerdict: 'PLAY_RECOGNIZED',
            certificateSha256Digest: ['test-cert-digest'],
            packageName: 'com.kilocode.kiloapp',
          },
          deviceIntegrity: {
            deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
          },
        },
      }),
    });

    const result = await verifyPlayIntegrity('test-integrity-token', 'challenge-value');

    expect(result).toEqual({ ok: true, packageName: 'com.kilocode.kiloapp' });
    // Google rejects the project-number-only path, so the exact URL must carry
    // the configured package name.
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://playintegrity.googleapis.com/v1/com.kilocode.kiloapp:decodeIntegrityToken',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-access-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ integrityToken: 'test-integrity-token' }),
      })
    );
  });

  test('surfaces an API status error without exposing the configured package name', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    try {
      await verifyPlayIntegrity('test-integrity-token', 'challenge-value');
      throw new Error('verifyPlayIntegrity should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe('Play Integrity API returned 500');
      expect(message).not.toContain('com.kilocode.kiloapp');
    }
  });
});
