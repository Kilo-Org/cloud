import { z } from 'zod';

import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { chainSave } from '@/lib/hooks/save-chain';
import { deliveryScope, readCacheScope } from '@/lib/persist/cache-scope';
import {
  capDeliveryItems,
  type DeliveryRecordRead,
  emptyDeliveryRecord,
  encodeDeliveryRecord,
  incompleteDeliveryRecord,
  type LegacyDeliveryRecord,
  readStoredDeliveryRecord,
  removeLegacyDeliveryRecord,
  seedDeliveryRecord,
  tombstoneOldSessions,
} from '@/lib/persist/delivery-record';
import * as encryptedKv from '@/lib/persist/encrypted-kv';

/**
 * Bounded, per-user memory of delivery failures the user already resolved by
 * retrying, keyed by session. The SDK clears the failed footer locally when a
 * retry is accepted, but the Durable Object replays its stored events on the
 * next open — including the original `cloud.message.failed` — so without this
 * the footer returns after a relaunch (`MUST stop showing after a successful
 * retry`, `.specs/cloud-agent-session.md` Errors 3).
 *
 * Lifetime: the record lives in `delivery:<userId>` (see `cache-scope.ts`), as
 * long as the replayed event it suppresses, not as long as the read cache. The
 * replay does not care that the user signed out, updated the app, or changed
 * `SCHEMA_VERSION`, and the footer's absence is a decision the user already
 * made; so the record must survive the `cache:<userId>:` sweep and a schema
 * bump. It is the same data class as a composer draft: account-scoped, in the
 * SQLCipher store, write-fenced on the auth epoch and on sign-out.
 *
 * The stored value is `{ items, complete }` per session. The item cap keeps
 * the newest {@link RESOLVED_DELIVERY_MAX_IDS} ids and marks a cut record
 * incomplete; the session cap retires the oldest session into an incomplete
 * tombstone instead of deleting it, because a deleted record reads as "never
 * resolved" — exactly the answer that restores a footer the user dismissed.
 * Only a session with nothing stored at all reads as a complete, empty record,
 * which is the ordinary state of a session whose footers were never dismissed.
 *
 * Records written before this scope existed are migrated on first read: the
 * legacy `readCacheScope(userId)` id array is adopted into `delivery:<userId>`
 * and never written again. Every failure is swallowed: this is a
 * footer-suppression hint, never a source of truth, so an unreadable or
 * unwritable entry must never affect the open or the retry path.
 */

/** At most this many resolved ids per session; the oldest are dropped. */
export const RESOLVED_DELIVERY_MAX_IDS = 100;

/**
 * At most this many sessions keep a recorded resolution per user. The delivery
 * scope is cleared only on an explicit account purge, so without a cap a
 * long-lived install would accumulate one entry per session the user retried.
 */
export const RESOLVED_DELIVERY_MAX_SESSIONS = 200;

const RESOLVED_DELIVERY_KEY_PREFIX = 'resolved-delivery:';

const resolvedIdSchema = z.string().min(1);

// The pre-migration shape: a bare array of message ids in the read-cache scope.
const legacyResolvedIdsSchema = z.array(resolvedIdSchema);

function resolvedDeliveryKey(sessionId: string): string {
  return `${RESOLVED_DELIVERY_KEY_PREFIX}${sessionId}`;
}

/**
 * Serializes the read-modify-write for one user's session through `chainSave`.
 * Keys are namespaced with the user id so one account's queue never blocks or
 * interleaves with another's in the same process.
 */
function resolvedDeliveryChainKey(userId: string, sessionId: string): string {
  return `${RESOLVED_DELIVERY_KEY_PREFIX}${userId}:${sessionId}`;
}

/**
 * The stored record, read without the chain. Callers inside `chainSave` must
 * use this rather than the public read, which may itself take the chain for the
 * legacy migration and would deadlock on the same key.
 */
function readStoredResolvedDelivery(
  userId: string,
  sessionId: string
): Promise<DeliveryRecordRead<string> | null> {
  return readStoredDeliveryRecord(
    deliveryScope(userId),
    resolvedDeliveryKey(sessionId),
    resolvedIdSchema
  );
}

/**
 * The pre-migration id array. `absent` and `unreadable` are kept apart: a
 * session that never had a record is complete, while a value this build cannot
 * parse must not be reported as one.
 */
async function probeLegacyResolvedDelivery(
  userId: string,
  sessionId: string
): Promise<LegacyDeliveryRecord<string>> {
  try {
    const raw = await encryptedKv.getItem(readCacheScope(userId), resolvedDeliveryKey(sessionId));
    if (raw === null) {
      return { state: 'absent' };
    }
    const parsed: unknown = JSON.parse(raw);
    const result = legacyResolvedIdsSchema.safeParse(parsed);
    return result.success ? { state: 'found', items: result.data } : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

/**
 * Adopts the legacy array into the delivery scope. Best effort: the caller
 * already has the items, and a failed write only means the next read migrates
 * again.
 */
async function migrateLegacyResolvedDelivery(
  userId: string,
  sessionId: string
): Promise<DeliveryRecordRead<string>> {
  const legacy = await probeLegacyResolvedDelivery(userId, sessionId);
  if (legacy.state === 'absent') {
    // Nothing was ever recorded for this session anywhere: a complete, empty
    // answer, not a cut-short one. A footer is shown or hidden on that
    // difference.
    return emptyDeliveryRecord();
  }
  if (legacy.state === 'unreadable') {
    return incompleteDeliveryRecord();
  }
  const adopted = capDeliveryItems(legacy.items, RESOLVED_DELIVERY_MAX_IDS, true);
  const scope = deliveryScope(userId);
  const legacyScope = readCacheScope(userId);
  const key = resolvedDeliveryKey(sessionId);
  try {
    await chainSave(resolvedDeliveryChainKey(userId, sessionId), async () => {
      // A migration during teardown would write into a scope that is no longer
      // the active account's, and the legacy blob is not cleared with it.
      if (isSignOutActive()) {
        return;
      }
      const current = await readStoredResolvedDelivery(userId, sessionId);
      if (current === null) {
        // Sign-out can start while that read was in flight, so the flag is
        // re-read here with no await in between.
        if (isSignOutActive()) {
          return;
        }
        await encryptedKv.setItem(scope, key, encodeDeliveryRecord(adopted));
        await tombstoneOldSessions({
          scope,
          prefix: RESOLVED_DELIVERY_KEY_PREFIX,
          max: RESOLVED_DELIVERY_MAX_SESSIONS,
          keepKey: key,
        });
      }
      // Either this call adopted the legacy array or a concurrent one already
      // had: in both cases `delivery:<userId>` is now authoritative, so the old
      // copy must go. Kept here, it would be adopted again the first time the
      // record empties, restoring a footer the user already resolved.
      await removeLegacyDeliveryRecord(legacyScope, key);
    });
  } catch {
    // The migration is a convenience; the read still answers with the ids.
  }
  return adopted;
}

/**
 * Reads the resolved delivery-failure ids for a session. A session with no
 * record anywhere is a complete, empty answer; a record this build cannot read
 * is reported as `{ items: [], complete: false }`.
 */
export async function readResolvedDeliveryFailures(
  userId: string,
  sessionId: string
): Promise<DeliveryRecordRead<string>> {
  if (userId === '' || sessionId === '') {
    return incompleteDeliveryRecord();
  }
  const stored = await readStoredResolvedDelivery(userId, sessionId);
  if (stored !== null) {
    return stored;
  }
  return migrateLegacyResolvedDelivery(userId, sessionId);
}

/**
 * Identity a resolution is written under. `userId` scopes the entry;
 * `authEpoch` is captured when the owning session manager is created, so the
 * write is refused once a sign-out/sign-in moves it.
 */
export type ResolvedDeliveryFailureOwner = {
  userId: string;
  authEpoch: number;
};

/**
 * Records one resolved delivery failure for a session. Refused while sign-out
 * is active or the owner's `authEpoch` has moved, and bounded to
 * {@link RESOLVED_DELIVERY_MAX_IDS} (oldest first). Never throws.
 *
 * The read-modify-write is serialized per user and session through
 * `chainSave` (the same pattern as `drafts.ts`): `persistResolvedDeliveryFailure`
 * is fired without awaiting per retry, so two overlapping calls would
 * otherwise both read the pre-write list and the later write would drop the
 * earlier id — restoring its footer after a relaunch.
 */
export async function persistResolvedDeliveryFailure(
  owner: ResolvedDeliveryFailureOwner,
  sessionId: string,
  messageId: string
): Promise<void> {
  const { userId, authEpoch } = owner;
  if (userId === '' || sessionId === '' || messageId === '') {
    return;
  }
  const scope = deliveryScope(userId);
  const key = resolvedDeliveryKey(sessionId);
  try {
    await chainSave(resolvedDeliveryChainKey(userId, sessionId), async () => {
      // Early exit, and the fence for the queued case: a write that chained
      // behind another one must not proceed once teardown has started.
      if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      const stored = await readStoredResolvedDelivery(userId, sessionId);
      // A write can arrive before any read migrated the legacy array; seeding
      // from it here keeps those ids instead of overwriting them with `[]`.
      // Once this write lands the delivery record is authoritative, so the
      // legacy copy is dropped below: kept, it would be adopted again after a
      // later empty leaves no record behind.
      const legacy = stored === null ? await probeLegacyResolvedDelivery(userId, sessionId) : null;
      const existing =
        stored ?? seedDeliveryRecord(legacy ?? { state: 'absent' }, RESOLVED_DELIVERY_MAX_IDS);
      const seededFromLegacy = legacy?.state === 'found';
      if (existing.items.includes(messageId)) {
        return;
      }
      const next = capDeliveryItems(
        [...existing.items, messageId],
        RESOLVED_DELIVERY_MAX_IDS,
        existing.complete
      );
      // The fence is re-read after the awaited reads and before the write, with
      // no await in between: sign-out flips its flag and bumps the epoch
      // synchronously, so a read that resolved past that moment must not
      // repopulate the scope teardown just cleared. Same fence as
      // `session-transcript-cache.ts`.
      if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      await encryptedKv.setItem(scope, key, encodeDeliveryRecord(next));
      if (seededFromLegacy) {
        await removeLegacyDeliveryRecord(readCacheScope(userId), key);
      }
      await tombstoneOldSessions({
        scope,
        prefix: RESOLVED_DELIVERY_KEY_PREFIX,
        max: RESOLVED_DELIVERY_MAX_SESSIONS,
        keepKey: key,
      });
    });
  } catch {
    // A failed write costs one restored footer, never a broken retry.
  }
}
