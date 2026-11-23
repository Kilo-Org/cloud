import * as AppIntegrity from '@expo/app-integrity';
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from 'expo-crypto';
import * as SecureStore from '@/lib/auth/secure-store';
import { Platform } from 'react-native';
import * as z from 'zod';

import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import {
  API_BASE_URL,
  NATIVE_ADMISSION_DEV_SENTINEL,
  PLAY_INTEGRITY_PROJECT_NUMBER,
} from '@/lib/config';
import { ATTEST_KEY_ID_KEY } from '@/lib/storage-keys';
import { reportAppAttestFailure } from '@/lib/telemetry/app-attest-events';

/** Must match `DEV_SENTINEL_PAYLOAD` in the web admission module. */
export const DEV_SENTINEL_PAYLOAD = 'native-admission-dev-sentinel';

export type AdmissionPayload = {
  platform: 'ios' | 'android';
  kind: 'attestation' | 'assertion';
  challenge: string;
  payload: string;
  keyId?: string;
};

/**
 * Error thrown when the admission challenge could not be obtained: the
 * endpoint answers a non-ok response, or the request or its body is aborted at
 * the `ADMISSION_CHALLENGE_TIMEOUT_MS` deadline. Any other failure of the
 * challenge request keeps its own error, and `getAdmission` rethrows a provider
 * failure rather than converting it; `resolveAdmission` in
 * `resolve-admission.ts` normalizes those errors into this sentinel. Callers
 * map this to a retryable sign-in message.
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

/**
 * Upper bound on the challenge request, response body included.
 *
 * A challenge that never answers holds the caller's in-flight sign-in guard, so
 * the control stays disabled with no message for the rest of the process. The
 * timer aborts the request instead of racing a promise, which releases the
 * connection and also ends a body read that stalls after the headers arrive.
 */
export const ADMISSION_CHALLENGE_TIMEOUT_MS = 15_000;

async function requestChallenge(): Promise<{ challenge: string }> {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, ADMISSION_CHALLENGE_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/native/admission-challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildClientMetadataHeaders() },
      body: JSON.stringify({ platform: Platform.OS === 'ios' ? 'ios' : 'android' }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(ADMISSION_CHALLENGE_FAILED);
    }

    // The body read is inside this try so an abort that lands after the
    // headers arrived still reads as the retryable sentinel below.
    return AdmissionChallengeResponseSchema.parse(await response.json());
  } catch (error) {
    // Any transport failure, including the deadline above, is retryable: the
    // caller must offer another attempt rather than submit a proof-less token
    // request. A schema rejection keeps its own error; the caller normalizes it.
    throw controller.signal.aborted ? new Error(ADMISSION_CHALLENGE_FAILED) : error;
  } finally {
    clearTimeout(deadline);
  }
}

export const AdmissionChallengeResponseSchema = z.object({ challenge: z.string().min(1) });

const invalidKeyErrorSchema = z.object({ code: z.literal('ERR_APP_INTEGRITY_INVALID_KEY') });

function isInvalidKeyError(error: unknown): boolean {
  return invalidKeyErrorSchema.safeParse(error).success;
}

const invalidInputErrorSchema = z.object({ code: z.literal('ERR_APP_INTEGRITY_INVALID_INPUT') });

/**
 * Run one native App Attest call, reporting a genuine rejection before it
 * propagates. The rejection is unchanged for the caller.
 */
async function callNativeStep<T>(
  step: 'generateKey' | 'attestKey',
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    reportAppAttestFailure(step, error);
    throw error;
  }
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
 *
 * Treat `invalidInput` on a stored-key assertion the same way: the bridge
 * hashes every challenge to 32 bytes, so retry with a fresh key once. Keep
 * reporting `invalidInput` to distinguish it from expected `invalidKey`.
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
        reportAppAttestFailure('generateAssertion', error);
        if (!invalidInputErrorSchema.safeParse(error).success) {
          throw error;
        }
      }
      await SecureStore.deleteItemAsync(ATTEST_KEY_ID_KEY);
    }
  }

  return attestFreshAppleKey(challenge);
}

/** Generate and attest one new Secure Enclave key, reporting a genuine failure. */
async function attestFreshAppleKey(challenge: string): Promise<AdmissionPayload> {
  const keyId = await callNativeStep('generateKey', () => AppIntegrity.generateKeyAsync());
  const payload = await callNativeStep('attestKey', () =>
    AppIntegrity.attestKeyAsync(keyId, challenge)
  );

  // Store only after a successful attestation. A stored id whose attestation
  // never reached the server would assert against a key the server does not know.
  await SecureStore.setItemAsync(ATTEST_KEY_ID_KEY, keyId);

  return { platform: 'ios', kind: 'attestation', challenge, payload, keyId };
}

// The Play Integrity token provider is prepared once per app launch. Hold the
// promise so concurrent sign-in attempts share one preparation, and drop it on
// failure so the next attempt retries instead of awaiting a rejected promise.
let integrityProvider: Promise<void> | undefined = undefined;

const PROVIDER_INVALID_CODE = 'ERR_APP_INTEGRITY_PROVIDER_INVALID';

const providerInvalidErrorSchema = z.object({ code: z.literal(PROVIDER_INVALID_CODE) });

/**
 * One token request on the shared provider.
 *
 * The Expo module keeps whichever provider it prepared, so Play Integrity's
 * `PROVIDER_INVALID` would fail every later request the same way. That exact
 * promise is dropped before rethrowing, and only that one: a replacement
 * another caller already started survives. Every other failure keeps the
 * provider as it was.
 */
async function requestIntegrityToken(projectNumber: string, requestHash: string): Promise<string> {
  integrityProvider ??= AppIntegrity.prepareIntegrityTokenProviderAsync(projectNumber);
  const provider = integrityProvider;
  try {
    await provider;
  } catch (error) {
    if (integrityProvider === provider) {
      integrityProvider = undefined;
    }
    throw error;
  }

  try {
    return await AppIntegrity.requestIntegrityCheckAsync(requestHash);
  } catch (error) {
    if (providerInvalidErrorSchema.safeParse(error).success && integrityProvider === provider) {
      integrityProvider = undefined;
    }
    throw error;
  }
}

/**
 * One token request, plus at most one replacement for the invalid-provider code.
 *
 * The replacement is the only retry: the Expo module keeps the provider it
 * prepared, so anything else means the device cannot attest right now and
 * another prepare would not change that.
 */
async function requestIntegrityTokenWithReplacement(
  projectNumber: string,
  requestHash: string
): Promise<string> {
  try {
    return await requestIntegrityToken(projectNumber, requestHash);
  } catch (error) {
    if (!providerInvalidErrorSchema.safeParse(error).success) {
      throw error;
    }
  }
  return requestIntegrityToken(projectNumber, requestHash);
}

/**
 * Produce an Android Play Integrity payload for the challenge.
 *
 * This is a standard request, so the binding travels in `requestHash` and the
 * verdict returns it verbatim. The hash is base64 SHA-256 of the challenge
 * string, which is what the server recomputes.
 */
async function getAndroidAdmission(challenge: string): Promise<AdmissionPayload> {
  const projectNumber = PLAY_INTEGRITY_PROJECT_NUMBER;
  if (!projectNumber) {
    throw new Error('Play Integrity project number is not configured');
  }

  const requestHash = await digestStringAsync(CryptoDigestAlgorithm.SHA256, challenge, {
    encoding: CryptoEncoding.BASE64,
  });

  return {
    platform: 'android',
    kind: 'assertion',
    challenge,
    payload: await requestIntegrityTokenWithReplacement(projectNumber, requestHash),
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
 * Returns `undefined` only when this device cannot attest at all, which the
 * server answers with the terminal device message. A failed attempt is not the
 * same thing: it throws, so the caller shows the retryable message instead of
 * telling the user to switch devices for a transient provider error.
 *
 * A non-production build configured with the sentinel sends the fixed proof for
 * a device that cannot attest. The server accepts it only when it also runs
 * outside production.
 */
export async function getAdmission(): Promise<AdmissionPayload | undefined> {
  const capable = hasAttestationCapability();

  if (!capable && !NATIVE_ADMISSION_DEV_SENTINEL) {
    // No proof is possible and no sentinel is configured: the server refuses
    // with the terminal device message.
    return undefined;
  }

  if (capable) {
    const { challenge } = await requestChallenge();
    try {
      return Platform.OS === 'ios'
        ? await getAppleAdmission(challenge)
        : await getAndroidAdmission(challenge);
    } catch (error) {
      // Only a non-production build may degrade to the sentinel; everywhere
      // else the failure is retryable and must reach the caller.
      if (!NATIVE_ADMISSION_DEV_SENTINEL) {
        throw error;
      }
    }
  }

  const { challenge } = await requestChallenge();
  return {
    // Android carries no key id, so the sentinel never needs one and the
    // server persists no attested key for it.
    platform: 'android',
    kind: 'assertion',
    challenge,
    payload: DEV_SENTINEL_PAYLOAD,
  };
}
