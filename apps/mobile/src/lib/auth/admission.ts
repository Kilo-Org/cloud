import { Platform } from 'react-native';

import { API_BASE_URL } from '@/lib/config';

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
 * Whether the current platform has the native attestation capability
 * available.  Returns false until the corresponding expo-device-check or
 * Play Integrity packages are installed.
 */
export function hasAttestationCapability(): boolean {
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

/**
 * Request a server admission challenge and produce a platform-specific
 * attestation or assertion.
 *
 * Returns `undefined` when the platform lacks attestation capability, so
 * the server's legacy path decides admission.
 *
 * Throws when the challenge endpoint is unreachable (5xx / network error).
 * Callers catch this and surface a retryable error message.
 */
export async function getAdmission(): Promise<AdmissionPayload | undefined> {
  if (!hasAttestationCapability()) {
    return undefined;
  }

  const { challenge } = await requestChallenge();
  const platform = Platform.OS === 'ios' ? ('ios' as const) : ('android' as const);

  if (Platform.OS === 'ios') {
    // When expo-device-check is installed:
    //   - If SecureStore has no keyId: generate a key, produce an attestation,
    //     return kind: 'attestation' with the new keyId.
    //   - If SecureStore has a keyId: produce an assertion,
    //     return kind: 'assertion' with the stored keyId.
    return {
      platform,
      kind: 'attestation',
      challenge,
      payload: '',
      keyId: undefined,
    };
  }

  // Android: when the Play Integrity package is installed:
  //   - Request a Play Integrity token for the challenge.
  //   - Return kind: 'assertion' with the integrity token as payload.
  return {
    platform,
    kind: 'assertion',
    challenge,
    payload: '',
  };
}
