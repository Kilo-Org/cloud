/* eslint-disable max-lines -- one admission suite: the challenge request, both platform providers, the provider replacement, and the sentinel fallback share one module-mock scaffold */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as AppIntegrity from '@expo/app-integrity';
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  ADMISSION_CHALLENGE_FAILED,
  ADMISSION_CHALLENGE_TIMEOUT_MS,
  AdmissionChallengeResponseSchema,
  clearAttestKeyOnRefusal,
  hasAttestationCapability,
} from './admission';
import { ATTEST_KEY_ID_KEY } from '@/lib/storage-keys';
import { type TelemetryEvent } from '@/lib/telemetry/error-sink';

/**
 * The Play Integrity provider is prepared once per module load, so each test
 * loads a fresh module. Without this the prepare-call assertions would depend
 * on which Android test ran first.
 */
async function loadGetAdmission() {
  vi.resetModules();
  const fresh = await import('./admission');
  return fresh.getAdmission;
}

/**
 * Load a fresh admission module with a telemetry sink installed in that same
 * module graph. `vi.resetModules()` gives the fresh graph its own
 * `error-sink` instance, so a sink installed on the test file's copy would
 * never receive the events.
 */
async function loadGetAdmissionWithEvents() {
  vi.resetModules();
  const sink = await import('@/lib/telemetry/error-sink');
  const events: TelemetryEvent[] = [];
  sink.setTelemetrySink(event => {
    events.push(event);
  });
  const fresh = await import('./admission');
  return { getAdmission: fresh.getAdmission, events };
}

const config = vi.hoisted(() => ({
  playIntegrityProjectNumber: undefined as string | undefined,
  nativeAdmissionDevSentinel: false as boolean,
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
  GOOGLE_WEB_CLIENT_ID: 'web-client-id',
  get PLAY_INTEGRITY_PROJECT_NUMBER() {
    return config.playIntegrityProjectNumber;
  },
  get NATIVE_ADMISSION_DEV_SENTINEL() {
    return config.nativeAdmissionDevSentinel;
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('@expo/app-integrity', () => ({
  isSupported: true,
  generateKeyAsync: vi.fn(),
  attestKeyAsync: vi.fn(),
  generateAssertionAsync: vi.fn(),
  prepareIntegrityTokenProviderAsync: vi.fn(),
  requestIntegrityCheckAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

// `client-metadata` builds the app `User-Agent` from `expo-application`, whose
// expo root needs `__DEV__` and cannot load in the node test environment.
vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
  digestStringAsync: vi.fn().mockResolvedValue('challenge-digest'),
}));

const originalFetch = globalThis.fetch;

/**
 * Answer the challenge endpoint with a fixed challenge, a fresh `Response` per
 * call so a test may exercise the sentinel fallback after a failed attempt.
 */
function setupChallengeFetch() {
  const fn = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(() => Promise.resolve(Response.json({ challenge: 'server-challenge' })));
  globalThis.fetch = fn;
  return fn;
}

function invalidKeyError() {
  return Object.assign(new Error('Invalid key provided'), {
    code: 'ERR_APP_INTEGRITY_INVALID_KEY',
  });
}

/** What the Expo module rejects with when Play Integrity invalidates its prepared provider. */
function providerInvalidError() {
  return Object.assign(new Error('Integrity token provider invalid'), {
    code: 'ERR_APP_INTEGRITY_PROVIDER_INVALID',
  });
}

/** A challenge that stalls until the request aborts: no answer, or headers then no body. */
function setupHangingFetch(headersArrive: boolean) {
  const signals: AbortSignal[] = [];
  globalThis.fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    (_input, init) => {
      const signal = init?.signal;
      const stalled = Promise.withResolvers<never>();
      signal?.addEventListener('abort', () => {
        stalled.reject(new DOMException('Aborted', 'AbortError'));
      });
      if (signal) {
        signals.push(signal);
      }
      if (!headersArrive) {
        return stalled.promise;
      }
      const response = new Response(null);
      vi.spyOn(response, 'json').mockReturnValue(stalled.promise);
      return Promise.resolve(response);
    }
  );
  return signals;
}

/** Android with a configured project number, a challenge endpoint, and a fresh module. */
function loadAndroidAdmission() {
  vi.mocked(Platform).OS = 'android';
  config.playIntegrityProjectNumber = '1234567890';
  config.nativeAdmissionDevSentinel = false;
  setupChallengeFetch();
  return loadGetAdmission();
}

describe('AdmissionChallengeResponseSchema', () => {
  it('parses a valid challenge body and ignores extra fields', () => {
    expect(
      AdmissionChallengeResponseSchema.parse({ challenge: 'server-challenge', extra: true })
    ).toEqual({
      challenge: 'server-challenge',
    });
  });

  // A body that cannot carry a challenge is unusable, not an empty challenge.
  it.each([{}, { challenge: '' }])('rejects %o', body => {
    expect(() => AdmissionChallengeResponseSchema.parse(body)).toThrow();
  });
});

describe('hasAttestationCapability', () => {
  afterEach(() => {
    vi.mocked(Platform).OS = 'ios';
    config.playIntegrityProjectNumber = undefined;
  });

  it('follows App Attest support on iOS', () => {
    vi.mocked(Platform).OS = 'ios';
    expect(hasAttestationCapability()).toBe(true);
  });

  it('is false on Android until a cloud project number is configured', () => {
    vi.mocked(Platform).OS = 'android';
    expect(hasAttestationCapability()).toBe(false);
    config.playIntegrityProjectNumber = '1234567890';
    expect(hasAttestationCapability()).toBe(true);
  });
});

describe('getAdmission', () => {
  beforeEach(() => {
    vi.mocked(Platform).OS = 'ios';
    config.playIntegrityProjectNumber = undefined;
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    vi.mocked(AppIntegrity.generateKeyAsync).mockResolvedValue('key-1');
    vi.mocked(AppIntegrity.attestKeyAsync).mockResolvedValue('attestation-b64');
    vi.mocked(AppIntegrity.generateAssertionAsync).mockResolvedValue('assertion-b64');
    vi.mocked(AppIntegrity.prepareIntegrityTokenProviderAsync).mockResolvedValue(undefined);
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync).mockResolvedValue('integrity-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ── Platform cannot attest ─────────────────────────────────────────────

  it('returns undefined without requesting a challenge when Android has no project number', async () => {
    vi.mocked(Platform).OS = 'android';
    const fetchSpy = setupChallengeFetch();
    const getAdmission = await loadGetAdmission();

    await expect(getAdmission()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── iOS ────────────────────────────────────────────────────────────────

  it('attests a fresh key on the first call and stores the key id', async () => {
    const fetchSpy = setupChallengeFetch();
    const getAdmission = await loadGetAdmission();

    await expect(getAdmission()).resolves.toEqual({
      platform: 'ios',
      kind: 'attestation',
      challenge: 'server-challenge',
      payload: 'attestation-b64',
      keyId: 'key-1',
    });
    expect(AppIntegrity.attestKeyAsync).toHaveBeenCalledWith('key-1', 'server-challenge');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(ATTEST_KEY_ID_KEY, 'key-1');
    // The challenge names the requesting build, and the body stays the
    // platform the server validates.
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'User-Agent': 'Kilo-Code/1.0.4 (ios)',
      'x-kilo-client': 'mobile',
      'x-kilo-app-platform': 'ios',
      'x-kilo-app-version': '1.0.4',
    });
    expect(init?.body).toBe(JSON.stringify({ platform: 'ios' }));
  });

  it('does not store the key id when attestation fails', async () => {
    setupChallengeFetch();
    const getAdmission = await loadGetAdmission();
    vi.mocked(AppIntegrity.attestKeyAsync).mockRejectedValue(new Error('attest failed'));

    await expect(getAdmission()).rejects.toThrow('attest failed');
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('asserts with the stored key id on later calls', async () => {
    setupChallengeFetch();
    const getAdmission = await loadGetAdmission();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('key-stored');

    await expect(getAdmission()).resolves.toEqual({
      platform: 'ios',
      kind: 'assertion',
      challenge: 'server-challenge',
      payload: 'assertion-b64',
      keyId: 'key-stored',
    });
    expect(AppIntegrity.generateKeyAsync).not.toHaveBeenCalled();
  });

  it('clears an unresolvable key id and re-attests once', async () => {
    setupChallengeFetch();
    const getAdmission = await loadGetAdmission();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('key-gone');
    vi.mocked(AppIntegrity.generateAssertionAsync).mockRejectedValue(invalidKeyError());

    await expect(getAdmission()).resolves.toMatchObject({
      kind: 'attestation',
      keyId: 'key-1',
    });
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(ATTEST_KEY_ID_KEY);
  });

  it('keeps the stored key id when the assertion fails for another reason', async () => {
    setupChallengeFetch();
    const getAdmission = await loadGetAdmission();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('key-stored');
    vi.mocked(AppIntegrity.generateAssertionAsync).mockRejectedValue(new Error('server down'));

    // A failed attempt is retryable, so it must reach the caller instead of
    // looking like a device that cannot attest.
    await expect(getAdmission()).rejects.toThrow('server down');
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(AppIntegrity.generateKeyAsync).not.toHaveBeenCalled();
  });

  // ── App Attest step diagnostics ────────────────────────────────────────

  it('reports a failed key generation by step and DeviceCheck code', async () => {
    setupChallengeFetch();
    const { getAdmission, events } = await loadGetAdmissionWithEvents();
    const failure = Object.assign(new Error('[ExpoAppIntegrity]: Unknown system failure'), {
      code: 'ERR_APP_INTEGRITY_SYSTEM_FAILURE',
    });
    vi.mocked(AppIntegrity.generateKeyAsync).mockRejectedValue(failure);

    await expect(getAdmission()).rejects.toBe(failure);

    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe('App Attest failure');
    expect(events[0]?.tags).toEqual({
      'app_attest.step': 'generateKey',
      'app_attest.error_domain': 'DCErrorDomain',
      'app_attest.error_code': 0,
    });
    // The rejection itself, its message and the key id stay out of the event.
    expect(events[0]).not.toHaveProperty('error');
    expect(JSON.stringify(events[0])).not.toContain('Unknown system failure');
    expect(JSON.stringify(events[0])).not.toContain('key-1');
  });

  it('reports a failed attestation by step and DeviceCheck code, and stores no key', async () => {
    setupChallengeFetch();
    const { getAdmission, events } = await loadGetAdmissionWithEvents();
    vi.mocked(AppIntegrity.attestKeyAsync).mockRejectedValue(
      Object.assign(new Error('[ExpoAppIntegrity]: Server unavailable'), {
        code: 'ERR_APP_INTEGRITY_SERVER_UNAVAILABLE',
      })
    );

    await expect(getAdmission()).rejects.toThrow('Server unavailable');

    expect(events.map(event => event.tags)).toEqual([
      {
        'app_attest.step': 'attestKey',
        'app_attest.error_domain': 'DCErrorDomain',
        'app_attest.error_code': 4,
      },
    ]);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("reports Expo's unknown fallback under the module's own domain", async () => {
    setupChallengeFetch();
    const { getAdmission, events } = await loadGetAdmissionWithEvents();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('key-stored');
    vi.mocked(AppIntegrity.generateAssertionAsync).mockRejectedValue(
      Object.assign(new Error('[ExpoAppIntegrity]: Unknown error'), {
        code: 'ERR_APP_INTEGRITY_UNKNOWN',
      })
    );

    await expect(getAdmission()).rejects.toThrow('Unknown error');

    expect(events.map(event => event.tags)).toEqual([
      {
        'app_attest.step': 'generateAssertion',
        'app_attest.error_domain': 'expo_app_integrity',
        'app_attest.error_code': 'ERR_APP_INTEGRITY_UNKNOWN',
      },
    ]);
  });

  it('reports a failed assertion with no recognized code, keeping only the step', async () => {
    setupChallengeFetch();
    const { getAdmission, events } = await loadGetAdmissionWithEvents();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('key-stored');
    vi.mocked(AppIntegrity.generateAssertionAsync).mockRejectedValue(
      new TypeError('Network request failed')
    );

    await expect(getAdmission()).rejects.toThrow('Network request failed');

    expect(events.map(event => event.tags)).toEqual([{ 'app_attest.step': 'generateAssertion' }]);
  });

  it('files nothing for the expected invalid-key recovery and still re-attests', async () => {
    setupChallengeFetch();
    const { getAdmission, events } = await loadGetAdmissionWithEvents();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('key-gone');
    vi.mocked(AppIntegrity.generateAssertionAsync).mockRejectedValue(invalidKeyError());

    await expect(getAdmission()).resolves.toMatchObject({
      kind: 'attestation',
      keyId: 'key-1',
    });

    expect(events).toEqual([]);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(ATTEST_KEY_ID_KEY);
  });

  it('files nothing on a successful attestation', async () => {
    setupChallengeFetch();
    const { getAdmission, events } = await loadGetAdmissionWithEvents();

    await expect(getAdmission()).resolves.toMatchObject({ kind: 'attestation' });

    expect(events).toEqual([]);
  });

  it('keeps Android free of App Attest events', async () => {
    vi.mocked(Platform).OS = 'android';
    config.playIntegrityProjectNumber = '1234567890';
    config.nativeAdmissionDevSentinel = false;
    setupChallengeFetch();
    const { getAdmission, events } = await loadGetAdmissionWithEvents();
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync).mockRejectedValue(
      Object.assign(new Error('Play Integrity unavailable'), {
        code: 'ERR_APP_INTEGRITY_API_NOT_AVAILABLE',
      })
    );

    await expect(getAdmission()).rejects.toThrow('Play Integrity unavailable');

    expect(events).toEqual([]);
  });

  // ── Android ────────────────────────────────────────────────────────────

  it('binds a standard Play Integrity request to the hashed challenge', async () => {
    const getAdmission = await loadAndroidAdmission();

    await expect(getAdmission()).resolves.toEqual({
      platform: 'android',
      kind: 'assertion',
      challenge: 'server-challenge',
      payload: 'integrity-token',
    });
    expect(AppIntegrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledWith('1234567890');
    // Standard requests bind through requestHash: base64 SHA-256 of the challenge.
    expect(digestStringAsync).toHaveBeenCalledWith(
      CryptoDigestAlgorithm.SHA256,
      'server-challenge',
      { encoding: CryptoEncoding.BASE64 }
    );
    expect(AppIntegrity.requestIntegrityCheckAsync).toHaveBeenCalledWith('challenge-digest');
  });

  it('replaces an invalidated provider once and uses the new one', async () => {
    const getAdmission = await loadAndroidAdmission();
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync)
      .mockRejectedValueOnce(providerInvalidError())
      .mockResolvedValueOnce('replacement-token');

    await expect(getAdmission()).resolves.toMatchObject({ payload: 'replacement-token' });
    // The Expo module keeps the provider it prepared, so a new one is prepared
    // rather than reusing the stale one.
    expect(AppIntegrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(2);
    expect(AppIntegrity.requestIntegrityCheckAsync).toHaveBeenCalledTimes(2);
  });

  it('does not prepare a replacement when the request fails for another reason', async () => {
    // A rooted device or one without Play Services cannot pass Play Integrity.
    // The failure must be retryable, not a silent "device unsupported".
    const getAdmission = await loadAndroidAdmission();
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync).mockRejectedValue(
      new Error('ERR_APP_INTEGRITY_API_NOT_AVAILABLE')
    );

    await expect(getAdmission()).rejects.toThrow('ERR_APP_INTEGRITY_API_NOT_AVAILABLE');
    expect(AppIntegrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(1);
    expect(AppIntegrity.requestIntegrityCheckAsync).toHaveBeenCalledTimes(1);
  });

  it('drops a second invalidated provider and makes the next attempt retry', async () => {
    const getAdmission = await loadAndroidAdmission();
    // One replacement is the bound: the second invalid answer is the retryable
    // failure the caller shows, not another prepare inside the same attempt.
    const failure = providerInvalidError();
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync).mockRejectedValue(failure);
    await expect(getAdmission()).rejects.toBe(failure);
    expect(AppIntegrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(2);

    // The stale provider is not remembered: the next user attempt prepares one.
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync).mockResolvedValue('integrity-token');
    await expect(getAdmission()).resolves.toMatchObject({ payload: 'integrity-token' });
    expect(AppIntegrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(3);
  });

  it('clears only the provider it captured, so a peer replacement survives', async () => {
    const getAdmission = await loadAndroidAdmission();
    // Both callers share the first provider and both get the invalid answer.
    // The first caller installs its replacement before the second handles that
    // answer, so an unconditional clear would drop it and prepare a third.
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync)
      .mockRejectedValueOnce(providerInvalidError())
      .mockRejectedValueOnce(providerInvalidError())
      .mockResolvedValue('integrity-token');

    await expect(Promise.all([getAdmission(), getAdmission()])).resolves.toHaveLength(2);

    expect(AppIntegrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(2);
  });

  // ── Non-production sentinel ────────────────────────────────────────────

  it('returns undefined when the device cannot attest and no sentinel is configured', async () => {
    vi.mocked(Platform).OS = 'android';
    config.playIntegrityProjectNumber = undefined;
    config.nativeAdmissionDevSentinel = false;
    const getAdmission = await loadGetAdmission();

    await expect(getAdmission()).resolves.toBeUndefined();
  });

  it('sends the sentinel proof when the device cannot attest and the sentinel is configured', async () => {
    vi.mocked(Platform).OS = 'android';
    config.playIntegrityProjectNumber = undefined;
    config.nativeAdmissionDevSentinel = true;
    setupChallengeFetch();
    const getAdmission = await loadGetAdmission();

    await expect(getAdmission()).resolves.toEqual({
      platform: 'android',
      kind: 'assertion',
      challenge: 'server-challenge',
      payload: 'native-admission-dev-sentinel',
    });
  });

  it('falls back to the sentinel when a configured device fails to attest', async () => {
    vi.mocked(Platform).OS = 'android';
    config.playIntegrityProjectNumber = '1234567890';
    config.nativeAdmissionDevSentinel = true;
    setupChallengeFetch();
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync).mockRejectedValue(
      new Error('ERR_APP_INTEGRITY_API_NOT_AVAILABLE')
    );
    const getAdmission = await loadGetAdmission();

    await expect(getAdmission()).resolves.toMatchObject({
      payload: 'native-admission-dev-sentinel',
    });
  });

  it('throws a retryable error when the challenge endpoint fails', async () => {
    globalThis.fetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 500 }));
    const getAdmission = await loadGetAdmission();

    await expect(getAdmission()).rejects.toThrow(ADMISSION_CHALLENGE_FAILED);
  });

  // No answer at all, and headers followed by a body that never completes: both
  // hold the caller's busy guard, so both must end at the deadline.
  it.each([{ headersArrive: false }, { headersArrive: true }])(
    'aborts a stalled challenge (headers: $headersArrive) so sign-in can retry',
    async ({ headersArrive }) => {
      const signals = setupHangingFetch(headersArrive);
      const getAdmission = await loadGetAdmission();
      vi.useFakeTimers();

      const settled = expect(getAdmission()).rejects.toThrow(ADMISSION_CHALLENGE_FAILED);
      await vi.advanceTimersByTimeAsync(ADMISSION_CHALLENGE_TIMEOUT_MS);
      await settled;

      expect(signals.map(signal => signal.aborted)).toEqual([true]);
    }
  );

  describe('clearAttestKeyOnRefusal', () => {
    it('drops the stored key id so the next attempt re-attests', async () => {
      // The server refuses an assertion for a key it never persisted. Without
      // the clear, the device asserts against that key forever.
      await clearAttestKeyOnRefusal('ADMISSION_REQUIRED');

      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(ATTEST_KEY_ID_KEY);
    });

    it('keeps the key id for any other error code', async () => {
      await clearAttestKeyOnRefusal('INVALID_CODE');
      await clearAttestKeyOnRefusal(undefined);

      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    });
  });
});
