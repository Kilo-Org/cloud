import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as AppIntegrity from '@expo/app-integrity';
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  ADMISSION_CHALLENGE_FAILED,
  AdmissionChallengeResponseSchema,
  clearAttestKeyOnRefusal,
  hasAttestationCapability,
} from './admission';
import { ATTEST_KEY_ID_KEY } from '@/lib/storage-keys';

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

const config = vi.hoisted(() => ({ playIntegrityProjectNumber: undefined as string | undefined }));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
  GOOGLE_WEB_CLIENT_ID: 'web-client-id',
  get PLAY_INTEGRITY_PROJECT_NUMBER() {
    return config.playIntegrityProjectNumber;
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

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
  digestStringAsync: vi.fn().mockResolvedValue('challenge-digest'),
}));

const originalFetch = globalThis.fetch;

/**
 * Resolve the challenge endpoint with a fixed challenge. The Response is a
 * single instance, so each test may call getAdmission once — a second call
 * would fail on an already-read body.
 */
function setupChallengeFetch(challenge = 'server-challenge') {
  const fn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ challenge }));
  globalThis.fetch = fn;
  return fn;
}

function invalidKeyError() {
  return Object.assign(new Error('Invalid key provided'), {
    code: 'ERR_APP_INTEGRITY_INVALID_KEY',
  });
}

describe('AdmissionChallengeResponseSchema', () => {
  it('parses a valid challenge body', () => {
    expect(AdmissionChallengeResponseSchema.parse({ challenge: 'server-challenge' })).toEqual({
      challenge: 'server-challenge',
    });
  });

  it('rejects a missing challenge field', () => {
    expect(() => AdmissionChallengeResponseSchema.parse({})).toThrow();
  });

  it('rejects an empty challenge string', () => {
    expect(() => AdmissionChallengeResponseSchema.parse({ challenge: '' })).toThrow();
  });

  it('ignores extra fields', () => {
    expect(
      AdmissionChallengeResponseSchema.parse({ challenge: 'server-challenge', extra: true })
    ).toEqual({ challenge: 'server-challenge' });
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
    setupChallengeFetch();
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
  });

  it('does not store the key id when attestation fails', async () => {
    setupChallengeFetch();
    const getAdmission = await loadGetAdmission();
    vi.mocked(AppIntegrity.attestKeyAsync).mockRejectedValue(new Error('attest failed'));

    await expect(getAdmission()).resolves.toBeUndefined();
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

    await expect(getAdmission()).resolves.toBeUndefined();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(AppIntegrity.generateKeyAsync).not.toHaveBeenCalled();
  });

  // ── Android ────────────────────────────────────────────────────────────

  it('binds a standard Play Integrity request to the hashed challenge', async () => {
    vi.mocked(Platform).OS = 'android';
    config.playIntegrityProjectNumber = '1234567890';
    setupChallengeFetch();
    const getAdmission = await loadGetAdmission();

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

  // ── Failure handling ───────────────────────────────────────────────────

  it('returns undefined when the integrity provider refuses the device', async () => {
    // A rooted device or one without Play Services must still be able to sign
    // in: admission is a server-side policy and the server holds the switch.
    vi.mocked(Platform).OS = 'android';
    config.playIntegrityProjectNumber = '1234567890';
    setupChallengeFetch();
    vi.mocked(AppIntegrity.requestIntegrityCheckAsync).mockRejectedValue(
      new Error('ERR_APP_INTEGRITY_API_NOT_AVAILABLE')
    );
    const getAdmission = await loadGetAdmission();

    await expect(getAdmission()).resolves.toBeUndefined();
  });

  it('throws a retryable error when the challenge endpoint fails', async () => {
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    const getAdmission = await loadGetAdmission();

    await expect(getAdmission()).rejects.toThrow(ADMISSION_CHALLENGE_FAILED);
  });

  it('exports ADMISSION_CHALLENGE_FAILED as a constant for caller catch blocks', () => {
    expect(ADMISSION_CHALLENGE_FAILED).toBe('admission_challenge_failed');
  });

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
