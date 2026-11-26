import { z } from 'zod';

/**
 * Device attestation of the mobile app `kilo-mobile` (design 5.5, decision Q67). The app proves at
 * its code exchange (`POST /token`, `grant_type=authorization_code`) that a genuine build of the
 * app on a genuine device holds the code: iOS with App Attest, Android with a Play Integrity
 * standard request. The proof is bound to the authorization code, so it is fresh (a code lives 60
 * seconds), it names one authorization request (the code is bound to its PKCE challenge, redirect
 * URI and DPoP key), and it cannot be used for another code.
 *
 * The challenge is the lowercase hex SHA-256 of the UTF-8 bytes of
 * `UTS_ATTESTATION_CHALLENGE_LABEL` followed by the code as the redirect delivered it
 * (`attestationChallengeInput`). The app hands that 64-character string to the platform:
 *
 * * iOS, first sign-in on this install (or after `attestation_required`): generate a new App Attest
 *   key and attest it over the challenge (`attestKeyAsync(keyId, challenge)`, which signs
 *   `SHA-256(UTF-8(challenge))` as the client data hash); send `attestation_type=app_attest_key`,
 *   `attestation_key_id` = the key id as Apple returns it (standard base64), `attestation` = the
 *   attestation object in standard base64.
 * * iOS, later sign-ins: an assertion with the stored key over the challenge
 *   (`generateAssertionAsync(keyId, challenge)`); send `attestation_type=app_attest_assertion`,
 *   the key id and the assertion in standard base64.
 * * Android: a Play Integrity standard request whose `requestHash` is the standard base64 of
 *   `SHA-256(UTF-8(challenge))`; send `attestation_type=play_integrity` and `attestation` = the
 *   integrity token, with no key id.
 *
 * A retry of the same exchange (same code, verifier and DPoP key, a fresh proof) needs no new
 * attestation once one was accepted for the code; UTS verifies each code's attestation once.
 */

/** The label the challenge hashes before the code. */
export const UTS_ATTESTATION_CHALLENGE_LABEL = 'kilo-uts-attestation-v1:';

/** The text whose SHA-256, in lowercase hex, is the attestation challenge of `code`. */
export function attestationChallengeInput(code: string): string {
  return `${UTS_ATTESTATION_CHALLENGE_LABEL}${code}`;
}

/** The token-request parameters that carry the attestation. */
export const UTS_ATTESTATION_PARAMS = {
  type: 'attestation_type',
  proof: 'attestation',
  keyId: 'attestation_key_id',
} as const;

export const UTS_ATTESTATION_TYPES = [
  'app_attest_key',
  'app_attest_assertion',
  'play_integrity',
] as const;
export const UtsAttestationTypeSchema = z.enum(UTS_ATTESTATION_TYPES);
export type UtsAttestationType = z.infer<typeof UtsAttestationTypeSchema>;

/**
 * The longest `attestation` value, in characters: an App Attest attestation object with its
 * certificate chain and receipt, or a Play Integrity token, stays well inside it.
 */
export const UTS_MAX_ATTESTATION_CHARS = 16 * 1024;
