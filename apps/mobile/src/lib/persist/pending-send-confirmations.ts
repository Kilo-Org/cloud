import { type PendingSendConfirmation } from '@kilocode/cloud-agent-sdk';
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
  writeDeliveryRecord,
} from '@/lib/persist/delivery-record';
import * as encryptedKv from '@/lib/persist/encrypted-kv';

/**
 * Bounded, per-user memory of message ids the client sent but the server did not
 * confirm yet, keyed by session. The SDK records one when a send fails without a
 * confirmed outcome: the transport reported an error, but the server may have
 * accepted the message before the response was lost. The confirmed row then
 * arrives on a later open, and the text the route restored is a duplicate of the
 * message that did arrive.
 *
 * The record must outlive the route that sent the message — that route's session
 * manager is destroyed when the reader leaves the session, while the restored
 * draft survives in the durable drafts store. So the read happens on every
 * session open, and the SDK retires the entry once the row is confirmed.
 *
 * Lifetime: the record lives in `delivery:<userId>` (see `cache-scope.ts`),
 * exactly as long as the composer draft it guards, not as long as the read
 * cache. The draft survives sign-out by design (it is the user's own
 * unsubmitted work), and withdrawing a duplicate-restoring hint that outlives
 * the cache is the same data class: account-scoped, encrypted at rest by the
 * same SQLCipher store, and still fenced on the auth epoch for every write.
 * Sharing the read-cache scope would clear the hints on sign-out and retire
 * them on every `SCHEMA_VERSION` bump, so a sign-in or an app update would
 * hand back a draft whose message had already been delivered.
 *
 * The stored value is `{ items, complete }` per session. The cap keeps the
 * newest {@link PENDING_SEND_MAX_IDS} ids and marks a cut record incomplete;
 * the session cap (also {@link PENDING_SEND_MAX_SESSIONS}) retires the oldest
 * session into an incomplete tombstone instead of deleting it, because a
 * deleted record reads as "nothing was ever pending" — exactly the answer that
 * puts a delivered message back in the composer. Only a session with nothing
 * stored at all reads as a complete, empty record.
 *
 * Records written before this scope existed are migrated on first read: the
 * legacy `readCacheScope(userId)` array is adopted into `delivery:<userId>` and
 * never written again. Every failure is swallowed: this only decides whether a
 * restored draft is a duplicate, so an unreadable or unwritable entry must
 * never affect the open, the send, or the composer.
 */

/** At most this many pending ids per session; the oldest are dropped. */
export const PENDING_SEND_MAX_IDS = 20;

/**
 * At most this many sessions keep a pending send per user. The delivery scope
 * is cleared only on an explicit account purge, so without a cap a long-lived
 * install would accumulate one entry per session that ever failed a send.
 */
export const PENDING_SEND_MAX_SESSIONS = 200;

const PENDING_SEND_KEY_PREFIX = 'pending-send:';

// `text` admits an empty string: a send may carry attachments only, and one
// such entry must not make every other entry in the list unreadable.
const pendingSendItemSchema = z.object({ messageId: z.string().min(1), text: z.string() });

// The pre-migration shape: a bare array in the read-cache scope.
const legacyPendingSendSchema = z.array(pendingSendItemSchema);

function pendingSendKey(sessionId: string): string {
  return `${PENDING_SEND_KEY_PREFIX}${sessionId}`;
}

/**
 * Serializes the read-modify-write for one user's session through `chainSave`.
 * Keys are namespaced with the user id so one account's queue never blocks or
 * interleaves with another's in the same process.
 */
function pendingSendChainKey(userId: string, sessionId: string): string {
  return `${PENDING_SEND_KEY_PREFIX}${userId}:${sessionId}`;
}

/**
 * The stored record, read without the chain. Callers inside `chainSave` must
 * use this rather than the public read, which may itself take the chain for the
 * legacy migration and would deadlock on the same key.
 */
function readStoredPendingSend(
  userId: string,
  sessionId: string
): Promise<DeliveryRecordRead<PendingSendConfirmation> | null> {
  return readStoredDeliveryRecord(
    deliveryScope(userId),
    pendingSendKey(sessionId),
    pendingSendItemSchema
  );
}

/**
 * The pre-migration array. `absent` and `unreadable` are kept apart: a session
 * that never had a record is complete, while a value this build cannot parse
 * must not be reported as one.
 */
async function probeLegacyPendingSend(
  userId: string,
  sessionId: string
): Promise<LegacyDeliveryRecord<PendingSendConfirmation>> {
  try {
    const raw = await encryptedKv.getItem(readCacheScope(userId), pendingSendKey(sessionId));
    if (raw === null) {
      return { state: 'absent' };
    }
    const parsed: unknown = JSON.parse(raw);
    const result = legacyPendingSendSchema.safeParse(parsed);
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
async function migrateLegacyPendingSend(
  userId: string,
  sessionId: string
): Promise<DeliveryRecordRead<PendingSendConfirmation>> {
  const legacy = await probeLegacyPendingSend(userId, sessionId);
  if (legacy.state === 'absent') {
    // Neither the delivery scope nor the read cache holds a record: this is the
    // ordinary state of a session that never failed a send, and it is a
    // *complete* answer. Reporting it as incomplete would make every healthy
    // session look cut short.
    return emptyDeliveryRecord();
  }
  if (legacy.state === 'unreadable') {
    return incompleteDeliveryRecord();
  }
  const adopted = capDeliveryItems(legacy.items, PENDING_SEND_MAX_IDS, true);
  const scope = deliveryScope(userId);
  const legacyScope = readCacheScope(userId);
  const key = pendingSendKey(sessionId);
  try {
    await chainSave(pendingSendChainKey(userId, sessionId), async () => {
      // A migration during teardown would write into a scope that is no longer
      // the active account's, and the legacy blob is not cleared with it.
      if (isSignOutActive()) {
        return;
      }
      const current = await readStoredPendingSend(userId, sessionId);
      if (current === null) {
        // Sign-out can start while that read was in flight, so the flag is
        // re-read here with no await in between.
        if (isSignOutActive()) {
          return;
        }
        await encryptedKv.setItem(scope, key, encodeDeliveryRecord(adopted));
        await tombstoneOldSessions({
          scope,
          prefix: PENDING_SEND_KEY_PREFIX,
          max: PENDING_SEND_MAX_SESSIONS,
          keepKey: key,
        });
      }
      // Either this call adopted the legacy array or a concurrent one already
      // had: in both cases `delivery:<userId>` is now authoritative, so the old
      // copy must go. Kept here, it would be adopted again by the next read
      // after the record empties and its key is removed, restoring a send the
      // server already confirmed.
      await removeLegacyDeliveryRecord(legacyScope, key);
    });
  } catch {
    // The migration is a convenience; the read still answers with the items.
  }
  return adopted;
}

/**
 * Reads the pending sends for a session. A session with no record anywhere is a
 * complete, empty answer; a record this build cannot read is reported as
 * `{ items: [], complete: false }`, so the caller can tell "nothing recorded"
 * from "cannot tell".
 */
export async function readPendingSendConfirmations(
  userId: string,
  sessionId: string
): Promise<DeliveryRecordRead<PendingSendConfirmation>> {
  if (userId === '' || sessionId === '') {
    return incompleteDeliveryRecord();
  }
  const stored = await readStoredPendingSend(userId, sessionId);
  if (stored !== null) {
    return stored;
  }
  return migrateLegacyPendingSend(userId, sessionId);
}

/**
 * Identity a pending send is written under. `userId` scopes the entry;
 * `authEpoch` is captured when the owning session manager is created, so the
 * write is refused once a sign-out/sign-in moves it.
 */
export type PendingSendOwner = {
  userId: string;
  authEpoch: number;
};

type PendingWrite = {
  owner: PendingSendOwner;
  sessionId: string;
  messageId: string;
  update: (
    existing: DeliveryRecordRead<PendingSendConfirmation>
  ) => DeliveryRecordRead<PendingSendConfirmation>;
};

async function writePending({ owner, sessionId, messageId, update }: PendingWrite): Promise<void> {
  const { userId, authEpoch } = owner;
  if (userId === '' || sessionId === '' || messageId === '') {
    return;
  }
  const scope = deliveryScope(userId);
  const key = pendingSendKey(sessionId);
  try {
    await chainSave(pendingSendChainKey(userId, sessionId), async () => {
      // Early exit, and the fence for the queued case: a write that chained
      // behind another one must not proceed once teardown has started.
      if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      const stored = await readStoredPendingSend(userId, sessionId);
      // A write can arrive before any read migrated the legacy array; seeding
      // from it here keeps those ids instead of overwriting them with `[]`.
      // Once this write lands the delivery record is authoritative, so the
      // legacy copy is dropped below: kept, it would be adopted again after a
      // later settle empties the record and removes its key.
      const legacy = stored === null ? await probeLegacyPendingSend(userId, sessionId) : null;
      const existing =
        stored ?? seedDeliveryRecord(legacy ?? { state: 'absent' }, PENDING_SEND_MAX_IDS);
      const seededFromLegacy = legacy?.state === 'found';
      const next = update(existing);
      // The fence is re-read after the awaited reads and before the write, with
      // no await in between: sign-out flips its flag and bumps the epoch
      // synchronously, so a read that resolved past that moment must not
      // repopulate the scope teardown just cleared.
      if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      await writeDeliveryRecord(scope, key, next);
      if (seededFromLegacy) {
        await removeLegacyDeliveryRecord(readCacheScope(userId), key);
      }
      await tombstoneOldSessions({
        scope,
        prefix: PENDING_SEND_KEY_PREFIX,
        max: PENDING_SEND_MAX_SESSIONS,
        keepKey: key,
      });
    });
  } catch {
    // A failed write costs one duplicate draft, never a broken send.
  }
}

/** Records one send whose outcome the server has not confirmed. Never throws. */
export async function persistPendingSendConfirmation(input: {
  owner: PendingSendOwner;
  sessionId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  const { messageId, text } = input;
  // An attachment-only send stores `text: ''` and is recorded like any other:
  // the composer restores the chips (`restoreChips`) whether or not the send
  // carried text, so an entry is the only thing that retires that restore when
  // the server turns out to have accepted the send. Skipping it left the chips
  // restored with no record, one reopen away from a duplicate send.
  await writePending({
    ...input,
    update: existing =>
      existing.items.some(entry => entry.messageId === messageId)
        ? existing
        : capDeliveryItems(
            [...existing.items, { messageId, text }],
            PENDING_SEND_MAX_IDS,
            existing.complete
          ),
  });
}

/** Retires a pending send once its confirmed row arrived. Never throws. */
export async function clearPendingSendConfirmation(input: {
  owner: PendingSendOwner;
  sessionId: string;
  messageId: string;
}): Promise<void> {
  const { messageId } = input;
  await writePending({
    ...input,
    update: existing =>
      existing.items.some(entry => entry.messageId === messageId)
        ? {
            items: existing.items.filter(entry => entry.messageId !== messageId),
            complete: existing.complete,
          }
        : existing,
  });
}
