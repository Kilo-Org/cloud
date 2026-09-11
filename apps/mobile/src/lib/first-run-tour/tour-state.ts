import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';

import { chainSave } from '@/lib/hooks/save-chain';
import { encodeStorageKey, FIRST_RUN_TOUR_KEY_PREFIX } from '@/lib/storage-keys';

/**
 * Persisted first-run tour decision for one account.
 *
 * The decision lives as its own SecureStore record (key
 * `encodeStorageKey(FIRST_RUN_TOUR_KEY_PREFIX, userId)`), exactly like the
 * per-account consent records (`@/lib/consent`,
 * `@/lib/voice-input/voice-network-consent`): a small terminal choice that
 * must survive sign-out, so the write carries NO auth-epoch fence (a decision
 * made before a sign-out must still land after it) and serialization runs
 * through `chainSave` per key.
 *
 * It deliberately does NOT live in the SQLCipher draft store. Measured live
 * on the first sign-in (2026-09-08): another JS context in the same process
 * (a background task, or a context that outlived a dev reload) can hold the
 * shared database file's write lock for the REST of the process lifetime, so
 * every draft write from the UI context fails busy past its 1 s timeout and
 * retries — a 'Skip tour' or hardware-back dismissal seconds after the
 * auto-open is swallowed, and the tour re-appears on the next cold start.
 * The tour decision is one short enum string; putting it behind that lock
 * traded a composer-draft-sized risk for the exact defect this feature exists
 * to prevent. SecureStore has no such shared lock (Android commits
 * synchronously to its own record, iOS writes the keychain).
 *
 * An absent or corrupt record loads as null, which means "eligible": a lost
 * decision errs toward showing the tour again rather than hiding it forever,
 * and there is no user action that re-reads a corrupt value, so null is the
 * only sensible fallback (the same containment contract as the consent
 * records).
 *
 * `markFirstRunTourStatus` awaits the write (the native call commits before
 * it resolves), CONFIRMS it by reading the record back, and latches the
 * outcome for this process synchronously, so a dismissal that does not wait
 * for the mark — the back guard replays the removal without awaiting — is
 * still covered by the gate. A write or confirm failure is retried with
 * backoff and, once the budget runs out, reported to Sentry and swallowed:
 * the fire-and-forget call sites can never leak an unhandled rejection, and
 * the documented fail-open contract stands.
 */

/** How the tour ended: completed to the last step, or skipped early. */
export type FirstRunTourStatus = 'done' | 'skipped';

/** Persisted first-run tour decision. */
export type FirstRunTourDecision = { status: FirstRunTourStatus };

/** SecureStore key for one account's tour decision. */
export function firstRunTourStorageKey(userId: string): string {
  return encodeStorageKey(FIRST_RUN_TOUR_KEY_PREFIX, userId);
}

/** Runtime shape guard for one stored tour status. */
export function isFirstRunTourStatus(value: unknown): value is FirstRunTourStatus {
  return value === 'done' || value === 'skipped';
}

/** Parse one raw SecureStore record; anything but a status reads as null. */
export function parseFirstRunTourRecord(raw: string | null): FirstRunTourDecision | null {
  if (raw !== null && isFirstRunTourStatus(raw)) {
    return { status: raw };
  }
  return null;
}

/**
 * Process-lifetime record of the accounts whose tour outcome this process
 * already recorded (`markFirstRunTourStatus` below).
 *
 * The gate consults it alongside the stored decision, because the decision
 * read alone cannot honor a decision that was JUST made: the dismissal paths
 * do not await the write (a held modal waiting on storage is its own defect),
 * so a gate re-arrival can race the in-flight record and read null. Measured
 * live: hardware back, then the tour re-opened 10 s later because the gate's
 * re-read raced the in-flight skip (2026-09-07). The latch is set
 * synchronously inside the mark, so the gate sees the decision before the
 * first await of the dismissal path.
 */
const recordedOutcomeUserIds = new Set<string>();

/** True once `markFirstRunTourStatus` ran for the account in this process. */
export function hasRecordedFirstRunTourOutcome(userId: string): boolean {
  return recordedOutcomeUserIds.has(userId);
}

/**
 * Loads the account's tour decision. Null when absent or corrupt — the
 * eligible default.
 */
export async function loadFirstRunTourDecision(
  userId: string
): Promise<FirstRunTourDecision | null> {
  if (!userId) {
    return null;
  }
  try {
    const raw = await SecureStore.getItemAsync(firstRunTourStorageKey(userId));
    return parseFirstRunTourRecord(raw);
  } catch (error) {
    // A failed read loads as null (fail open, same containment as the
    // drafts layer) but is reported: this read decides whether a person who
    // already dismissed the tour sees it again.
    reportDecisionFailure(error, 'read');
    return null;
  }
}

/**
 * Backoff between decision-write re-issues after a write or confirm failed.
 * SecureStore has no shared-database lock to wait out, so this covers real
 * native failures (a transient keystore or I/O error); the first attempt
 * lands in all but those cases. Total worst-case budget ~7.8 s of backoff
 * plus six attempts, all in the background; past it the documented
 * fail-open contract stands (a lost decision errs toward showing the tour
 * again) — with a Sentry report, because unlike a lost composer draft this
 * loss re-opens a tour the person already dismissed.
 */
const DECISION_WRITE_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

function reportDecisionFailure(error: unknown, operation: 'read' | 'write'): void {
  Sentry.captureException(error, {
    level: 'warning',
    tags: { 'error.subsystem': 'first-run-tour', 'error.operation': operation },
    fingerprint: ['first-run-tour-decision-write-lost'],
  });
}

/**
 * Records how the tour ended and confirms it landed before resolving. The
 * latch is set before any await (see {@link hasRecordedFirstRunTourOutcome})
 * so a caller that dismisses the tour without awaiting this mark — the back
 * guard replays the removal without waiting for the write — is still covered.
 *
 * Each write runs serialized per key through `chainSave` (the consent-record
 * pattern): two marks for the same account never interleave. After the write,
 * the record is read back; any stored decision ends the loop, including one
 * with a DIFFERENT status: that is a later dismissal whose own mark owns its
 * confirmation, and it must not be overwritten by this earlier one — so the
 * confirm runs BEFORE every re-issue, never after it. A failed write or
 * confirm is reported and re-issued with backoff until the decision is stored
 * or the budget runs out — in the background, never in the dismissal path
 * (the UI already moved on; the latch covers this process).
 */
export async function markFirstRunTourStatus(
  userId: string,
  status: FirstRunTourStatus
): Promise<void> {
  recordedOutcomeUserIds.add(userId);
  if (!userId) {
    return;
  }
  const key = firstRunTourStorageKey(userId);
  await writeDecisionRecord(key, status);
  for (const delayMs of DECISION_WRITE_RETRY_DELAYS_MS) {
    // eslint-disable-next-line no-await-in-loop -- every step depends on the previous attempt's outcome: re-issuing blind would overwrite a later dismissal's decision
    if ((await readDecisionRecord(key)) !== null) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- the backoff IS the retry policy
    await new Promise<void>(resolve => {
      setTimeout(resolve, delayMs);
    });
    // eslint-disable-next-line no-await-in-loop -- the re-issue must settle (or fail) before the next backoff step is decided
    await writeDecisionRecord(key, status);
  }
}

/** One serialized SecureStore write; failures are reported, never thrown. */
async function writeDecisionRecord(key: string, status: FirstRunTourStatus): Promise<void> {
  try {
    await chainSave(key, async () => {
      await SecureStore.setItemAsync(key, status);
    });
  } catch (error) {
    reportDecisionFailure(error, 'write');
  }
}

/** One serialized read-back; a failure reads as null (eligible). */
async function readDecisionRecord(key: string): Promise<FirstRunTourDecision | null> {
  try {
    const raw = await chainSave(key, async () => {
      const value = await SecureStore.getItemAsync(key);
      return value;
    });
    return parseFirstRunTourRecord(raw);
  } catch (error) {
    reportDecisionFailure(error, 'read');
    return null;
  }
}
