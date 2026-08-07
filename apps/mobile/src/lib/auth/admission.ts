import * as AppIntegrity from '@expo/app-integrity';
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { API_BASE_URL, PLAY_INTEGRITY_PROJECT_NUMBER } from '@/lib/config';
import { ATTEST_KEY_ID_KEY } from '@/lib/storage-keys';

export type AdmissionPayload = {
  platform: 'ios' | 'android';
  kind: 'attestation' | 'assertion';
  challenge: string;
  payload: string;
  keyId?: string;
};

/**
 * Error thrown when the admission challenge endpoint is unreachable
 * (5xx or network error).  Callers map this to a retryable sign-in message.
 */
export const ADMISSION_CHALLENGE_FAILED = 'admission_challenge_failed';

/**
 * Whether this device can produce an admission payload at all.
 *
 * iOS reports App Attest support directly; the simulator and older devices
 * return false. Android has no equivalent probe for Play Integrity, so the
 * gate is whether a cloud project number is configured.
 */
export function hasAttestationCapability(): boolean {
  if (Platform.OS === 'ios') {
    return AppIntegrity.isSupported;
  }
  if (Platform.OS === 'android') {
    return Boolean(PLAY_INTEGRITY_PROJECT_NUMBER);
  }
  return false;
}

async function requestChallenge(): Promise<{ challenge: string }> {
  const response = await fetch(`${API_BASE_URL}/api/auth/native/admission-challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: Platform.OS === 'ios' ? 'ios' : 'android' }),
  });

  if (!response.ok) {
    throw new Error(ADMISSION_CHALLENGE_FAILED);
  }

  return response.json() as Promise<{ challenge: string }>;
}

function isInvalidKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ERR_APP_INTEGRITY_INVALID_KEY'
  );
}

/**
 * Produce an iOS App Attest payload for the challenge.
 *
 * The first call generates a Secure Enclave key and attests it; later calls
 * assert with the stored key id. `attestKeyAsync` and `generateAssertionAsync`
 * hash the challenge string's UTF-8 bytes into clientDataHash, so the server
 * must hash the same bytes.
 *
 * An `invalidKey` rejection means the stored key id no longer resolves — the
 * app was reinstalled, or restored onto another device. Clear it and re-attest
 * once, so the device is not stuck asserting against a key that is gone.
 */
async function getAppleAdmission(challenge: string): Promise<AdmissionPayload> {
  const storedKeyId = await SecureStore.getItemAsync(ATTEST_KEY_ID_KEY);

  if (storedKeyId) {
    try {
      return {
        platform: 'ios',
        kind: 'assertion',
        challenge,
        payload: await AppIntegrity.generateAssertionAsync(storedKeyId, challenge),
        keyId: storedKeyId,
      };
    } catch (error) {
      if (!isInvalidKeyError(error)) {
        throw error;
      }
      await SecureStore.deleteItemAsync(ATTEST_KEY_ID_KEY);
    }
  }

  const keyId = await AppIntegrity.generateKeyAsync();
  const payload = await AppIntegrity.attestKeyAsync(keyId, challenge);
  // Store only after a successful attestation. A stored id whose attestation
  // never reached the server would assert against a key the server does not know.
  await SecureStore.setItemAsync(ATTEST_KEY_ID_KEY, keyId);

  return { platform: 'ios', kind: 'attestation', challenge, payload, keyId };
}

// The Play Integrity token provider is prepared once per app launch. Hold the
// promise so concurrent sign-in attempts share one preparation, and drop it on
// failure so the next attempt retries instead of awaiting a rejected promise.
let integrityProvider: Promise<void> | undefined = undefined;

async function prepareIntegrityProvider(projectNumber: string): Promise<void> {
  integrityProvider ??= AppIntegrity.prepareIntegrityTokenProviderAsync(projectNumber);
  try {
    await integrityProvider;
  } catch (error) {
    // Drop the rejected promise so the next sign-in retries preparation
    // instead of awaiting a promise that can only reject.
    integrityProvider = undefined;
    throw error;
  }
}

/**
 * Produce an Android Play Integrity payload for the challenge.
 *
 * This is a standard request, so the binding travels in `requestHash` and the
 * verdict returns it verbatim. The hash is base64 SHA-256 of the challenge
 * string, which is what the server recomputes.
 */
async function getAndroidAdmission(challenge: string): Promise<AdmissionPayload> {
  if (!PLAY_INTEGRITY_PROJECT_NUMBER) {
    throw new Error('Play Integrity project number is not configured');
  }

  await prepareIntegrityProvider(PLAY_INTEGRITY_PROJECT_NUMBER);

  const requestHash = await digestStringAsync(CryptoDigestAlgorithm.SHA256, challenge, {
    encoding: CryptoEncoding.BASE64,
  });

  return {
    platform: 'android',
    kind: 'assertion',
    challenge,
    payload: await AppIntegrity.requestIntegrityCheckAsync(requestHash),
  };
}

/**
 * Drop the stored key id when the server refuses admission.
 *
 * The client stores the key id as soon as `attestKeyAsync` resolves, which says
 * nothing about whether the server accepted and persisted the key. When it did
 * not, every later sign-in asserts against a key the server has never seen and
 * is refused forever. Clearing the id makes the next attempt re-attest, which
 * Apple still has to sign, so this weakens nothing.
 */
export async function clearAttestKeyOnRefusal(errorCode: string | undefined): Promise<void> {
  if (errorCode === 'ADMISSION_REQUIRED' && Platform.OS === 'ios') {
    await SecureStore.deleteItemAsync(ATTEST_KEY_ID_KEY);
  }
}

/**
 * Request a server admission challenge and produce a platform-specific
 * attestation or assertion.
 *
 * Returns `undefined` when this device cannot produce one, so the server's
 * counted legacy path decides admission. A provider failure — no Play
 * Services, a rooted device, a transient Google error — also returns
 * `undefined` rather than aborting sign-in: admission is a server-side policy
 * and the server holds the mode switch. Failing closed here would lock users
 * out even while `NATIVE_ADMISSION_MODE` is `off`.
 *
 * Throws only when the challenge endpoint is unreachable. Callers catch that
 * and surface a retryable error message.
 */
export async function getAdmission(): Promise<AdmissionPayload | undefined> {
  if (!hasAttestationCapability()) {
    return undefined;
  }

  const { challenge } = await requestChallenge();

  try {
    return Platform.OS === 'ios'
      ? await getAppleAdmission(challenge)
      : await getAndroidAdmission(challenge);
  } catch {
    return undefined;
  }
}
