import * as SecureStore from 'expo-secure-store';

import { E2E_SECURE_STORE_FAULT_MS } from '@/lib/config';

/**
 * Bounded retry for a stored credential read.
 *
 * A keychain/keystore read can reject transiently — the device just rebooted
 * and the keystore is not unlocked yet, or the platform service is momentarily
 * unavailable. Bootstrap must never read that rejection as "no stored
 * session": doing so presents a signed-in person with the login screen while
 * their credentials are still on the device. Only a rejection is retried; a
 * `null` resolution is a real answer (nothing stored) and returns immediately.
 */
const RETRY_DELAYS_MS = [250, 500, 1000] as const;

// Bundle-time E2E fault hook, the same precedent as `E2E_LATENCY_*` in
// lib/config: while the window is open, every read through this helper
// rejects, which is what makes the session-restore failure states provable on
// a live build. Env-gated, so the constant is 0 and this is inert in
// production.
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
  options: SecureStore.SecureStoreOptions | undefined,
  firstAttempt: Promise<string | null> | undefined
): Promise<string | null> {
  if (isFaultWindowOpen()) {
    throw new Error(`E2E secure-store fault window is open: read of ${key} rejected`);
  }
  const value = await (firstAttempt ?? SecureStore.getItemAsync(key, options));
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
  options?: SecureStore.SecureStoreOptions,
  firstAttempt?: Promise<string | null>
): Promise<string | null> {
  let pending = firstAttempt;
  for (const retryDelayMs of RETRY_DELAYS_MS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- retry cadence: each attempt must settle before the next backoff
      return await readOnce(key, options, pending);
    } catch {
      pending = undefined;
      // eslint-disable-next-line no-await-in-loop -- backoff between attempts
      await delay(retryDelayMs);
    }
  }
  // Last attempt: its rejection is the final answer and propagates to the
  // caller, which owns how the failure is surfaced.
  return readOnce(key, options, pending);
}
