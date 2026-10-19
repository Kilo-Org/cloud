/**
 * Tests for findings #9 (cert digest enforcement), #12 (simulator bypass
 * production guard), and the Play Integrity decode endpoint fix (the resource
 * path must carry the configured package name, not the project number).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  isProductionInternal,
  resetAccessTokenCacheForTests,
  verifyPlayIntegrity,
} from './native-admission-google';

// Values are read lazily (via getters) so tests can vary the configuration.
const mockConfig = {
  GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME: 'com.kilocode.kiloapp',
  GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER: '123456789',
  GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: '',
  GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS: 'test-cert-digest',
};

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
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
    resetAccessTokenCacheForTests();
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

  test('accepts a standard request bound through requestHash', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    });
    const expectedHash = createHash('sha256').update('challenge-value', 'utf8').digest('base64');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tokenPayloadExternal: {
          // Standard requests return requestHash verbatim and carry no nonce.
          requestDetails: {
            requestPackageName: 'com.kilocode.kiloapp',
            requestHash: expectedHash,
          },
          appIntegrity: {
            appRecognitionVerdict: 'PLAY_RECOGNIZED',
            certificateSha256Digest: ['test-cert-digest'],
            packageName: 'com.kilocode.kiloapp',
          },
          deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
        },
      }),
    });

    const result = await verifyPlayIntegrity('test-integrity-token', 'challenge-value');

    expect(result).toEqual({ ok: true, packageName: 'com.kilocode.kiloapp' });
  });

  test('refuses a standard request whose requestHash binds another challenge', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    });
    const otherHash = createHash('sha256').update('other-challenge', 'utf8').digest('base64');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tokenPayloadExternal: {
          requestDetails: {
            requestPackageName: 'com.kilocode.kiloapp',
            requestHash: otherHash,
          },
          appIntegrity: {
            appRecognitionVerdict: 'PLAY_RECOGNIZED',
            certificateSha256Digest: ['test-cert-digest'],
            packageName: 'com.kilocode.kiloapp',
          },
          deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
        },
      }),
    });

    const result = await verifyPlayIntegrity('test-integrity-token', 'challenge-value');

    expect(result).toEqual({ ok: false, error: 'NONCE_MISMATCH' });
  });

  test('refuses a verdict that carries no request binding', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tokenPayloadExternal: {
          requestDetails: { requestPackageName: 'com.kilocode.kiloapp' },
          appIntegrity: {
            appRecognitionVerdict: 'PLAY_RECOGNIZED',
            certificateSha256Digest: ['test-cert-digest'],
            packageName: 'com.kilocode.kiloapp',
          },
          deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
        },
      }),
    });

    const result = await verifyPlayIntegrity('test-integrity-token', 'challenge-value');

    expect(result).toEqual({ ok: false, error: 'NONCE_MISMATCH' });
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

// ── Access token cache and request timeouts ──────────────────────────────

describe('verifyPlayIntegrity access token cache', () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    mockConfig.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY = JSON.stringify({
      client_email: 'cache-test@example.iam.gserviceaccount.com',
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
    resetAccessTokenCacheForTests();
  });

  const validVerdict = (hash: string) => ({
    ok: true,
    json: async () => ({
      tokenPayloadExternal: {
        requestDetails: {
          requestPackageName: 'com.kilocode.kiloapp',
          requestHash: hash,
        },
        appIntegrity: {
          appRecognitionVerdict: 'PLAY_RECOGNIZED',
          certificateSha256Digest: ['test-cert-digest'],
          packageName: 'com.kilocode.kiloapp',
        },
        deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
      },
    }),
  });

  test('reuses the cached token so a second verification makes no token call', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'token-one', expires_in: 3600 }),
    });
    const hash1 = createHash('sha256').update('challenge-1', 'utf8').digest('base64');
    mockFetch.mockResolvedValueOnce(validVerdict(hash1));

    const first = await verifyPlayIntegrity('integrity-1', 'challenge-1');
    expect(first).toEqual({ ok: true, packageName: 'com.kilocode.kiloapp' });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const hash2 = createHash('sha256').update('challenge-2', 'utf8').digest('base64');
    mockFetch.mockResolvedValueOnce(validVerdict(hash2));

    const second = await verifyPlayIntegrity('integrity-2', 'challenge-2');
    expect(second).toEqual({ ok: true, packageName: 'com.kilocode.kiloapp' });
    // Only the decode call ran again; the token call hit the cache.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://playintegrity.googleapis.com/v1/com.kilocode.kiloapp:decodeIntegrityToken',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-one' }),
      })
    );
  });

  test('refreshes once the cached token enters the expiry margin', async () => {
    // expires_in = 240 s keeps the token inside the 5-minute margin
    // immediately, so the next verification must mint a fresh token.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'token-one', expires_in: 240 }),
    });
    const hash1 = createHash('sha256').update('challenge-1', 'utf8').digest('base64');
    mockFetch.mockResolvedValueOnce(validVerdict(hash1));
    await verifyPlayIntegrity('integrity-1', 'challenge-1');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'token-two', expires_in: 3600 }),
    });
    const hash2 = createHash('sha256').update('challenge-2', 'utf8').digest('base64');
    mockFetch.mockResolvedValueOnce(validVerdict(hash2));
    await verifyPlayIntegrity('integrity-2', 'challenge-2');

    const tokenCalls = mockFetch.mock.calls.filter(
      ([url]) => url === 'https://oauth2.googleapis.com/token'
    );
    expect(tokenCalls).toHaveLength(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://playintegrity.googleapis.com/v1/com.kilocode.kiloapp:decodeIntegrityToken',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-two' }),
      })
    );
  });

  test('concurrent verifications share one token refresh', async () => {
    const { promise: tokenPromise, resolve: resolveToken } = Promise.withResolvers<unknown>();
    mockFetch.mockImplementationOnce(() => tokenPromise);
    const hash = createHash('sha256').update('challenge-1', 'utf8').digest('base64');

    const first = verifyPlayIntegrity('integrity-1', 'challenge-1');
    const second = verifyPlayIntegrity('integrity-2', 'challenge-1');

    resolveToken({
      ok: true,
      json: async () => ({ access_token: 'shared-token', expires_in: 3600 }),
    });
    mockFetch.mockResolvedValue(validVerdict(hash));

    await Promise.all([first, second]);
    const tokenCalls = mockFetch.mock.calls.filter(
      ([url]) => url === 'https://oauth2.googleapis.com/token'
    );
    expect(tokenCalls).toHaveLength(1);
  });

  test('both Google calls carry an abort timeout signal', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'token-one', expires_in: 3600 }),
    });
    const hash = createHash('sha256').update('challenge-1', 'utf8').digest('base64');
    mockFetch.mockResolvedValueOnce(validVerdict(hash));

    await verifyPlayIntegrity('integrity-1', 'challenge-1');

    for (const call of mockFetch.mock.calls) {
      const init = call[1] as { signal?: AbortSignal };
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('a failed token refresh clears the cache so the next caller retries', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(verifyPlayIntegrity('integrity-1', 'challenge-1')).rejects.toThrow(
      'Failed to obtain Play Integrity access token'
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'token-after-failure', expires_in: 3600 }),
    });
    const hash = createHash('sha256').update('challenge-1', 'utf8').digest('base64');
    mockFetch.mockResolvedValueOnce(validVerdict(hash));

    const result = await verifyPlayIntegrity('integrity-1', 'challenge-1');
    expect(result).toEqual({ ok: true, packageName: 'com.kilocode.kiloapp' });
  });
});
