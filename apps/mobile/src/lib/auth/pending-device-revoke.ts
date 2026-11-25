import { CONTROL_PLANE_DEADLINE_MS, withDeadline } from '@kilocode/event-service';
import * as Sentry from '@sentry/react-native';
import { z } from 'zod';

import {
  deleteStoredValueSafe,
  readStoredValueForUpdate,
  writeStoredValueSafe,
} from '@/lib/auth/secure-store-value';
import { API_BASE_URL } from '@/lib/config';
import { chainSave } from '@/lib/hooks/save-chain';
import { PENDING_DEVICE_REVOKE_KEY } from '@/lib/storage-keys';

/**
 * Retry for a sign-out whose device-session revoke failed.
 *
 * Sign-out revokes the session while the access token still authenticates the
 * call. When that fails — offline, a deadline, a 5xx, or an access token that
 * already expired — the session row stays live. It is not dead weight: the
 * server's Home widget verifier keeps accepting the widget's 30-day credential
 * for as long as the session is unrevoked and has an unconsumed, unexpired
 * refresh row, so the widget keeps drawing the signed-out account's sessions.
 * The refresh token is the one credential left that can revoke the row after
 * the app deletes its pair, so a failed revoke is recorded here and retried by
 * refresh token on the next launch or foreground.
 *
 * The record is a bounded list because each sign-out of the same device leaves
 * its own session: a later failure must not overwrite a token that is still
 * owed. Entries are keyed by token, never by account, so a newer sign-in on the
 * same device cannot be revoked by a retry — the retry sends only the recorded
 * old token.
 *
 * The route answers `200` for every outcome it can settle (revoked, already
 * revoked, unknown token), so the client needs no body classification: any
 * non-2xx answer, or no answer, is retryable. A record stops being retried when
 * the server settles it or when the token can no longer name a live refresh
 * row. The token is never logged, reported, or attached to telemetry.
 */

/**
 * How long a record stays retryable. The server mints refresh tokens for 30
 * days; the client does not know the exact expiry of the token it saved, so it
 * uses the maximum lifetime. That over-estimates, which is safe: the server
 * answers `unknown_token` (a settled outcome) once the row is gone or expired.
 */
const RETRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Foreground flaps must not hammer the route; one pass a minute is enough. */
const MIN_ATTEMPT_SPACING_MS = 60_000;

const REVOKE_PATH = '/api/auth/native/revoke';

/** One recorded revision's own route answer; a missing or odd body still settles. */
const revokeResponseSchema = z.object({
  outcome: z.enum(['revoked', 'already_revoked', 'unknown_token']),
});

/**
 * One recorded revoke. `retryUntilMs` is the client-side ceiling described
 * above; an entry past it is dropped without a request.
 */
const pendingDeviceRevokeSchema = z.object({
  refreshToken: z.string().min(1),
  retryUntilMs: z.number().int().positive(),
});
type PendingDeviceRevoke = z.infer<typeof pendingDeviceRevokeSchema>;

const pendingDeviceRevokeStoreSchema = z.object({
  version: z.literal(1),
  revokes: z.array(pendingDeviceRevokeSchema),
});

/**
 * The four states one reconciliation pass reports. `revoked` covers every
 * settled success (the server revoked it, it was already revoked); `terminal`
 * covers the entries the server refused or that expired, so the caller can tell
 * "we cleaned up" from "there was nothing left to clean up".
 */
export type DeviceRevokeRetryOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'retryable'; readonly reason: 'unreachable' | 'refused' | 'unreadable' }
  | { readonly kind: 'terminal'; readonly reason: 'unknown-token' | 'expired' };

type StoreRead =
  | { readonly status: 'value'; readonly revokes: PendingDeviceRevoke[] }
  | { readonly status: 'unreadable' }
  /** A payload this build cannot decode; left as it is for the build that wrote it. */
  | { readonly status: 'undecodable' };

type AttemptResult =
  | { readonly kind: 'revoked' }
  | { readonly kind: 'terminal'; readonly reason: 'unknown-token' }
  | { readonly kind: 'retryable'; readonly reason: 'unreachable' | 'refused' };

let attemptInFlight: Promise<DeviceRevokeRetryOutcome> | null = null;
let lastAttemptAtMs = 0;

/** Test seam: forget the single-flight and spacing state between tests. */
export function resetPendingDeviceRevokeForTests(): void {
  attemptInFlight = null;
  lastAttemptAtMs = 0;
}

function parseStore(raw: string | null): PendingDeviceRevoke[] | null {
  if (raw === null) {
    return [];
  }
  let value: unknown = undefined;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = pendingDeviceRevokeStoreSchema.safeParse(value);
  return parsed.success ? parsed.data.revokes : null;
}

async function readStore(): Promise<StoreRead> {
  const stored = await readStoredValueForUpdate(PENDING_DEVICE_REVOKE_KEY);
  if (stored.status === 'unreadable') {
    return { status: 'unreadable' };
  }
  const revokes = parseStore(stored.value);
  return revokes === null ? { status: 'undecodable' } : { status: 'value', revokes };
}

/** Writes the list, deleting the key when nothing is owed. Total: never throws. */
function writeStore(revokes: readonly PendingDeviceRevoke[]): Promise<boolean> {
  const byToken = new Map<string, PendingDeviceRevoke>();
  for (const revoke of revokes) {
    byToken.set(revoke.refreshToken, revoke);
  }
  const live = [...byToken.values()];
  return live.length === 0
    ? deleteStoredValueSafe(PENDING_DEVICE_REVOKE_KEY)
    : writeStoredValueSafe(
        PENDING_DEVICE_REVOKE_KEY,
        JSON.stringify({ version: 1, revokes: live })
      );
}

/**
 * Record a session whose revoke must still happen. Best effort by contract: a
 * keychain refusal leaves the record for a later sign-out to write, and never
 * fails the sign-out that is already in progress.
 */
export async function recordPendingDeviceSessionRevoke(refreshToken: string): Promise<void> {
  await chainSave(PENDING_DEVICE_REVOKE_KEY, async () => {
    const stored = await readStore();
    // Never overwrite a payload this process could not read or decode: it may
    // hold entries that are still owed.
    if (stored.status !== 'value') {
      return;
    }
    const now = Date.now();
    const kept = stored.revokes.filter(
      revoke => revoke.retryUntilMs > now && revoke.refreshToken !== refreshToken
    );
    kept.push({ refreshToken, retryUntilMs: now + RETRY_WINDOW_MS });
    await writeStore(kept);
  });
}

/**
 * Record a sign-out whose device-session revoke did not settle, or report that
 * it cannot be retried. A missing token — the keychain refused the read, or the
 * pair was already deleted — leaves nothing to retry. Best effort, and never
 * logs the token.
 */
export async function recordFailedDeviceSessionRevoke(refreshToken: string | null): Promise<void> {
  if (refreshToken === null) {
    Sentry.captureMessage('Device session revoke could not be retried', {
      level: 'warning',
      tags: { 'error.subsystem': 'auth', 'error.operation': 'device_revoke_retry_unavailable' },
    });
    return;
  }
  await recordPendingDeviceSessionRevoke(refreshToken);
}

async function sendRevoke(refreshToken: string): Promise<AttemptResult> {
  try {
    return await withDeadline(CONTROL_PLANE_DEADLINE_MS, async signal => {
      const response = await fetch(`${API_BASE_URL}${REVOKE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal,
      });
      if (response.status >= 200 && response.status < 300) {
        // A 2xx already proves the server settled this token; the body only
        // distinguishes the outcomes for the caller's report.
        const parsed = revokeResponseSchema.safeParse(await response.json().catch(() => undefined));
        return parsed.success && parsed.data.outcome === 'unknown_token'
          ? { kind: 'terminal', reason: 'unknown-token' }
          : { kind: 'revoked' };
      }
      // Any non-2xx answer — a 5xx, a 429, a proxy's 403, a route that is not
      // deployed yet — proves nothing about the recorded session, so the record
      // stays and the bounded window ends it.
      return { kind: 'retryable', reason: 'refused' };
    });
  } catch {
    return { kind: 'retryable', reason: 'unreachable' };
  }
}

async function runRetryPass(now: number): Promise<DeviceRevokeRetryOutcome> {
  const stored = await readStore();
  if (stored.status === 'unreadable') {
    return { kind: 'retryable', reason: 'unreadable' };
  }
  if (stored.status === 'undecodable') {
    return { kind: 'none' };
  }
  const due = stored.revokes.filter(revoke => revoke.retryUntilMs > now);
  const expiredCount = stored.revokes.length - due.length;
  if (due.length === 0) {
    if (expiredCount === 0) {
      return { kind: 'none' };
    }
    await chainSave(PENDING_DEVICE_REVOKE_KEY, async () => {
      const after = await readStore();
      if (after.status === 'value') {
        await writeStore(after.revokes.filter(revoke => revoke.retryUntilMs > Date.now()));
      }
    });
    return { kind: 'terminal', reason: 'expired' };
  }

  const results = await Promise.all(due.map(revoke => sendRevoke(revoke.refreshToken)));

  // Drop exactly the tokens this pass settled, re-reading first so an entry a
  // concurrent sign-out recorded during the network pass survives.
  await chainSave(PENDING_DEVICE_REVOKE_KEY, async () => {
    const after = await readStore();
    if (after.status !== 'value') {
      return;
    }
    const settled = new Set(
      due
        .filter((_, index) => results[index]?.kind !== 'retryable')
        .map(revoke => revoke.refreshToken)
    );
    const nowAfter = Date.now();
    const kept = after.revokes.filter(
      revoke => !settled.has(revoke.refreshToken) && revoke.retryUntilMs > nowAfter
    );
    if (kept.length !== after.revokes.length) {
      await writeStore(kept);
    }
  });

  const retryable = results.find(result => result.kind === 'retryable');
  if (retryable?.kind === 'retryable') {
    return { kind: 'retryable', reason: retryable.reason };
  }
  if (results.some(result => result.kind === 'revoked')) {
    return { kind: 'revoked' };
  }
  return { kind: 'terminal', reason: expiredCount > 0 ? 'expired' : 'unknown-token' };
}

/**
 * Retry every recorded revoke now. One admission guard and one spacing window
 * mean two triggers (a launch and a foreground, or a foreground flap) can never
 * run the pass twice; a caller that arrives during a pass joins it.
 */
export async function retryPendingDeviceSessionRevoke(): Promise<DeviceRevokeRetryOutcome> {
  if (attemptInFlight !== null) {
    return attemptInFlight;
  }
  const now = Date.now();
  if (now - lastAttemptAtMs < MIN_ATTEMPT_SPACING_MS) {
    return { kind: 'none' };
  }
  lastAttemptAtMs = now;
  const attempt = runRetryPass(now);
  attemptInFlight = attempt;
  try {
    return await attempt;
  } finally {
    if (attemptInFlight === attempt) {
      attemptInFlight = null;
    }
  }
}
