import 'server-only';
import { getEnvVariable } from '@/lib/dotenvx';
import { captureMessage } from '@sentry/nextjs';

export type NativeAdmissionMode = 'off' | 'report' | 'enforce';

export type NativeAdmissionResult = { ok: true } | { ok: false; errorCode: 'ADMISSION_REQUIRED' };

/**
 * Evaluate admission for a native auth request.
 *
 * In this commit the admission check has no attestation provider. C14 adds
 * the provider. The deployment default is 'off'.
 *
 * Behavior by mode:
 * - 'off':      admit everything.
 * - 'report':   evaluate (log), but always admit. Not yet used without a
 *               provider, so it behaves the same as 'off' in this commit.
 * - 'enforce':  fail closed.
 *   - If the body has an `admission` field: verify it. The field must be
 *     present, well-formed, not expired, not replayed, and match the
 *     expected value. Any mismatch or absence of mandatory sub-fields
 *     returns ADMISSION_REQUIRED.
 *   - If the body does NOT have an `admission` field: admit and count
 *     the legacy path. This is the only way a shipped app that cannot
 *     be updated over the air keeps working. Once the legacy counter
 *     drains, this path is deleted.
 *
 * A provider error (e.g., external service failure) is thrown as a 5xx,
 * never a 403 admission refusal.
 *
 * @param body The parsed request body.
 */
export function checkNativeAdmission(body: Record<string, unknown>): NativeAdmissionResult {
  const mode = getEnvVariable('NATIVE_ADMISSION_MODE') as NativeAdmissionMode;

  // 'off' and 'report': admit everything in this commit.
  if (mode !== 'enforce') {
    return { ok: true };
  }

  // 'enforce': fail closed.
  const hasAdmission = 'admission' in body && body['admission'] !== undefined;

  if (!hasAdmission) {
    // Legacy admit path: no admission field present.
    // The client is a shipped build that cannot be updated over the air.
    // ponytail: remove legacy counter and this branch after C14 ships and
    // the counter drains.
    captureMessage('native_admission_legacy_count: 1');
    return { ok: true };
  }

  // In this commit there is no provider, so any present admission field
  // cannot be verified. Fail closed.
  // C14 adds the provider and replaces this with actual verification.
  return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
}
