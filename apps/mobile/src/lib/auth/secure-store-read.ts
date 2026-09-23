import { readStoredValue, type SecureStoreReadOptions } from '@/lib/auth/secure-store-value';
import { E2E_SECURE_STORE_FAULT_MS } from '@/lib/config';
import { E2eInjectedFaultError } from '@/lib/telemetry/e2e-fault';

/**
 * Bounded retry for a stored credential read.
 *
 * A keychain/keystore read can reject transiently — the device just rebooted
 * and the keystore is not unlocked yet, or the platform service is momentarily
 * unavailable. Bootstrap must never read that rejection as "no stored
 * session": doing so presents a signed-in person with the login screen while
 * their credentials are still on the device. Only a rejection is retried by
 * `readStoredValueWithRetry`; a `null` resolution is a real answer (nothing
 * stored) and returns immediately.
 *
 * A `null` is not always a real answer: a `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
 * item answers `null` while the device is not yet unlocked, which is
 * indistinguishable from "nothing stored". `readStoredValueRetryingNull`
 * retries a `null` on the same schedule, for the callers that treat a member
 * of the credential set as unreadable rather than absent.
 */
const RETRY_DELAYS_MS = [250, 500, 1000] as const;

// Bundle-time E2E fault hook, the same precedent as `E2E_LATENCY_*` in
// lib/config: while the window is open, every read through this helper
// rejects, which is what makes the session-restore failure states provable on
// a live build. Env-gated, so the constant is 0 and this is inert in
// production. The rejection is an `E2eInjectedFaultError`, which the Sentry
// `beforeSend` gate drops so a harness fault is never filed as a product issue.
const moduleLoadTime = Date.now();

function isFaultWindowOpen(): boolean {
  return E2E_SECURE_STORE_FAULT_MS > 0 && Date.now() - moduleLoadTime < E2E_SECURE_STORE_FAULT_MS;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

/** One attempt: the handed-over read if there is one, otherwise a fresh one. */
async function readOnce(
  key: string,
  options: SecureStoreReadOptions | undefined,
  firstAttempt: Promise<string | null> | undefined
): Promise<string | null> {
  if (isFaultWindowOpen()) {
    throw new E2eInjectedFaultError(
      `E2E secure-store fault window is open: read of ${key} rejected`
    );
  }
  const value = await (firstAttempt ?? readStoredValue(key, options));
  return value;
}

/**
 * Reads `key`, retrying only a rejected read up to three more times with
 * 250/500/1000 ms backoff before rethrowing the last error.
 *
 * `firstAttempt` lets a caller hand over a read that is already in flight
 * (the module-scope preload promises in auth-context), so a healthy cold start
 * costs exactly the reads it costs today; retries always issue a fresh read.
 */
export async function readStoredValueWithRetry(
  key: string,
  options?: SecureStoreReadOptions,
  firstAttempt?: Promise<string | null>
): Promise<string | null> {
  const value = await readWithRetry(key, { options, firstAttempt, nullIsFailure: false });
  return value;
}

/**
 * Reads `key` like `readStoredValueWithRetry`, but treats a `null` resolution
 * as a failed read and retries it on the same 250/500/1000 ms cadence. The
 * final attempt's `null` is returned when the budget is spent; a rejection
 * still propagates after the budget, exactly as `readStoredValueWithRetry`
 * does.
 *
 * Use this for a member of the credential set: while the device is not yet
 * unlocked, a read of a `WHEN_UNLOCKED_THIS_DEVICE_ONLY` key answers `null`,
 * which must not be read as "no stored session".
 */
export async function readStoredValueRetryingNull(
  key: string,
  options?: SecureStoreReadOptions,
  firstAttempt?: Promise<string | null>
): Promise<string | null> {
  const value = await readWithRetry(key, { options, firstAttempt, nullIsFailure: true });
  return value;
}

/**
 * The one retry loop both exports share: four attempts (three more after the
 * first) with 250/500/1000 ms backoff. A rejection always spends an attempt
 * and backs off; a `null` resolution spends an attempt only when the caller
 * counts it as a failure (`nullIsFailure`).
 */
type RetryRead = {
  options: SecureStoreReadOptions | undefined;
  firstAttempt: Promise<string | null> | undefined;
  nullIsFailure: boolean;
};

async function readWithRetry(key: string, read: RetryRead): Promise<string | null> {
  let pending = read.firstAttempt;
  for (const retryDelayMs of RETRY_DELAYS_MS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- retry cadence: each attempt must settle before the next backoff
      const value = await readOnce(key, read.options, pending);
      if (value !== null || !read.nullIsFailure) {
        return value;
      }
    } catch {
      // A rejection spends this attempt; the next one issues a fresh read.
    }
    pending = undefined;
    // eslint-disable-next-line no-await-in-loop -- backoff between attempts
    await delay(retryDelayMs);
  }
  // Last attempt: its value is the final answer, and its rejection propagates
  // to the caller, which owns how the failure is surfaced.
  return readOnce(key, read.options, pending);
}
