/**
 * Tests for findings #9 (cert digest enforcement), the Play Integrity decode
 * endpoint fix (the resource path must carry the configured package name, not
 * the project number), and the cached access token with bounded provider calls.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest as jestGlobal,
} from '@jest/globals';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { resetAccessTokenCacheForTests, verifyPlayIntegrity } from './native-admission-google';

import { captureMessage } from '@sentry/nextjs';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  countAdmissionCondition,
  resetAdmissionCountersForTests,
} from './native-admission-telemetry';

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
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  warnExceptInTest: jest.fn(),
}));

const mockCaptureMessage = jest.mocked(captureMessage);
const mockWarnExceptInTest = jest.mocked(warnExceptInTest);

// The admission aggregate flushes on wall-clock window boundaries, so the
// clock is pinned and refusal tests force flushes at fixed 6.x million-ms
// instants.
const now = jestGlobal.spyOn(Date, 'now');
now.mockReturnValue(6_000_000);

/** The aggregate telemetry line the admission module writes once per window. */
type AggregateLine = {
  event: 'native_admission_aggregate';
  metric: string;
  count: number;
  intervalMs: number;
  windowStart: string;
  at: string;
};

/** Aggregate lines written to the warn sink so far, in emission order. */
function aggregateLines(): AggregateLine[] {
  return mockWarnExceptInTest.mock.calls.flatMap(([message]: unknown[]) => {
    const parsed = JSON.parse(String(message)) as { event?: string };
    return parsed.event === 'native_admission_aggregate' ? [parsed as AggregateLine] : [];
  });
}

/** Aggregate lines carrying one metric, in emission order. */
function metricLines(metric: string): AggregateLine[] {
  return aggregateLines().filter(line => line.metric === metric);
}

// ── Missing credentials fail closed ───────────────────────────────────────

describe('verifyPlayIntegrity without credentials', () => {
  const configured: typeof mockConfig = { ...mockConfig };

  afterEach(() => {
    Object.assign(mockConfig, configured);
  });

  test('throws so the route surfaces a retryable 5xx', async () => {
    // Missing credentials mean the verdict cannot be checked. Throwing keeps
    // this an infrastructure fault instead of a refusal of the device.
    mockConfig.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY = '';
    await expect(verifyPlayIntegrity('fake-token', 'fake-challenge')).rejects.toThrow(
      'Google Play Integrity credentials not configured'
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith('google_play_integrity_missing_credentials');
    expect(aggregateLines()).toStrictEqual([]);
  });

  test.each([undefined, '', ' , , '])(
    'reports and throws on a %s certificate-digest allowlist',
    async allowlist => {
      Object.assign(mockConfig, configured);
      // The reordered fault branch reports the credential inputs first, so the
      // allowlist cases need their credential inputs present. The value never
      // reaches the access-token flow: a null config throws before it runs.
      mockConfig.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY = 'unused-in-config-check';
      if (allowlist === undefined) {
        delete (mockConfig as Record<string, unknown>).GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS;
      } else {
        mockConfig.GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS = allowlist;
      }

      await expect(verifyPlayIntegrity('fake-token', 'fake-challenge')).rejects.toThrow(
        'Google Play Integrity certificate allowlist not configured'
      );
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'play_integrity_cert_digest_allowlist_missing'
      );
      expect(aggregateLines()).toStrictEqual([]);
    }
  );

  test('names the credential gap when it coincides with an allowlist gap', async () => {
    Object.assign(mockConfig, configured);
    mockConfig.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY = '';
    mockConfig.GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS = '';
    mockCaptureMessage.mockClear();

    await expect(verifyPlayIntegrity('fake-token', 'fake-challenge')).rejects.toThrow(
      'Google Play Integrity credentials not configured'
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith('google_play_integrity_missing_credentials');
    expect(mockCaptureMessage).not.toHaveBeenCalledWith(
      'play_integrity_cert_digest_allowlist_missing'
    );
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
    resetAdmissionCountersForTests();
    // A preceding test pins the clock at a flush instant; this describe's
    // refusal tests count from 6_000_000, so repin before every test.
    now.mockReturnValue(6_000_000);
    mockWarnExceptInTest.mockClear();
    mockCaptureMessage.mockClear();
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

  test('counts a standard request whose requestHash binds another challenge', async () => {
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
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  test('counts a verdict that carries no request binding', async () => {
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
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    now.mockReturnValue(6_061_000);
    countAdmissionCondition('native_admission_missing');
    const missing = metricLines('play_integrity_missing_request_hash');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ count: 1 });
  });

  test('surfaces an API status error and keeps its per-event report', async () => {
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
    // The provider status fault keeps its per-event report.
    expect(mockCaptureMessage).toHaveBeenCalledWith('play_integrity_api_status: 500');
  });

  test('counts each verdict refusal on its own aggregate metric', async () => {
    // Unrecognized app verdict.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    });
    mockFetch.mockResolvedValueOnce(verdictWithAppVerdict('UNRECOGNIZED'));

    // Insufficient device verdict.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    });
    mockFetch.mockResolvedValueOnce(verdictWithDeviceVerdicts(['MEETS_BASIC_INTEGRITY']));

    await verifyPlayIntegrity('test-integrity-token', 'challenge-value');
    resetAccessTokenCacheForTests();
    await verifyPlayIntegrity('test-integrity-token', 'challenge-value');

    expect(mockCaptureMessage).not.toHaveBeenCalled();

    now.mockReturnValue(6_121_000);
    countAdmissionCondition('native_admission_missing');

    const appLines = metricLines('play_integrity_app_unrecognized');
    expect(appLines).toHaveLength(1);
    expect(appLines[0]).toMatchObject({ count: 1 });

    const deviceLines = metricLines('play_integrity_device_verdict_insufficient');
    expect(deviceLines).toHaveLength(1);
    expect(deviceLines[0]).toMatchObject({ count: 1 });

    expect(aggregateLines().filter(line => line.metric.startsWith('play_integrity'))).toHaveLength(
      2
    );
  });

  test('counts a verdict whose device-integrity array is absent or empty', async () => {
    // Empty deviceRecognitionVerdict array: refused before the label lookup.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    });
    mockFetch.mockResolvedValueOnce(verdictWithDeviceVerdicts([]));

    const result = await verifyPlayIntegrity('test-integrity-token', 'challenge-value');
    expect(result).toEqual({ ok: false, error: 'DEVICE_NOT_RECOGNIZED' });
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    now.mockReturnValue(6_061_000);
    countAdmissionCondition('native_admission_missing');
    const lines = metricLines('play_integrity_device_verdict_insufficient');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ count: 1 });
  });
});

/**
 * Verdict payload with a mutable appRecognitionVerdict, so tests can drive the
 * app-recognition refusal branch without duplicating the full body.
 */
function verdictWithAppVerdict(appRecognitionVerdict: string) {
  return {
    ok: true,
    json: async () => ({
      tokenPayloadExternal: {
        requestDetails: {
          requestPackageName: 'com.kilocode.kiloapp',
          requestHash: createHash('sha256').update('challenge-value', 'utf8').digest('base64'),
        },
        appIntegrity: {
          appRecognitionVerdict,
          certificateSha256Digest: ['test-cert-digest'],
          packageName: 'com.kilocode.kiloapp',
        },
        deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
      },
    }),
  };
}

/**
 * Verdict payload with mutable deviceRecognitionVerdicts, so tests can drive
 * the device-refusal branch without duplicating the full body.
 */
function verdictWithDeviceVerdicts(deviceRecognitionVerdict: string[]) {
  return {
    ok: true,
    json: async () => ({
      tokenPayloadExternal: {
        requestDetails: {
          requestPackageName: 'com.kilocode.kiloapp',
          requestHash: createHash('sha256').update('challenge-value', 'utf8').digest('base64'),
        },
        appIntegrity: {
          appRecognitionVerdict: 'PLAY_RECOGNIZED',
          certificateSha256Digest: ['test-cert-digest'],
          packageName: 'com.kilocode.kiloapp',
        },
        deviceIntegrity: { deviceRecognitionVerdict },
      },
    }),
  };
}

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

  test('both Google calls carry the 10s abort timeout signal', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    try {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-one', expires_in: 3600 }),
      });
      const hash = createHash('sha256').update('challenge-1', 'utf8').digest('base64');
      mockFetch.mockResolvedValueOnce(validVerdict(hash));

      await verifyPlayIntegrity('integrity-1', 'challenge-1');

      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      for (const call of timeoutSpy.mock.calls) {
        expect(call[0]).toBe(10_000);
      }
    } finally {
      timeoutSpy.mockRestore();
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
