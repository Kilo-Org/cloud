import { type PendingSendConfirmation } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { chainSave } from '@/lib/hooks/save-chain';
import * as encryptedKv from '@/lib/persist/encrypted-kv';
import { readCacheScope } from '@/lib/persist/read-cache';

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
 * Scope and retirement reuse the read cache: the blob lives in
 * `readCacheScope(userId)`, so sign-out's `cache:<userId>:` prefix clear
 * removes it and a `SCHEMA_VERSION` bump retires it without extra cleanup. The
 * item key is `pending-send:<sessionId>`.
 *
 * Every failure is swallowed: this only decides whether a restored draft is a
 * duplicate, so an unreadable or unwritable entry must never affect the open,
 * the send, or the composer.
 */

/** At most this many pending ids per session; the oldest are evicted. */
export const PENDING_SEND_MAX_IDS = 20;

/**
 * At most this many sessions keep a pending send per user. Like the transcript
 * cache, the scope is otherwise cleared only on sign-out, so without a cap a
 * long-lived install would accumulate one entry per session that ever failed a
 * send.
 */
export const PENDING_SEND_MAX_SESSIONS = 20;

const PENDING_SEND_KEY_PREFIX = 'pending-send:';

const pendingSendSchema = z.array(
  z.object({ messageId: z.string().min(1), text: z.string().min(1) })
);

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
 * Drops the oldest session entries beyond the cap for this key family only;
 * the read-cache blob, transcript pages and the resolved-delivery records in
 * the same scope are untouched. `listEntries` is ascending by `updatedAt`.
 */
async function evictOldestSessions(scope: string): Promise<void> {
  const entries = await encryptedKv.listEntries(scope);
  const pending = entries.filter(entry => entry.k.startsWith(PENDING_SEND_KEY_PREFIX));
  const excess = pending.length - PENDING_SEND_MAX_SESSIONS;
  if (excess <= 0) {
    return;
  }
  await Promise.all(
    pending.slice(0, excess).map(async entry => {
      await encryptedKv.removeItem(scope, entry.k);
    })
  );
}

/** Reads the pending sends for a session; `[]` on any miss. */
export async function readPendingSendConfirmations(
  userId: string,
  sessionId: string
): Promise<readonly PendingSendConfirmation[]> {
  if (userId === '' || sessionId === '') {
    return [];
  }
  try {
    const raw = await encryptedKv.getItem(readCacheScope(userId), pendingSendKey(sessionId));
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    const result = pendingSendSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
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
  update: (existing: readonly PendingSendConfirmation[]) => readonly PendingSendConfirmation[];
};

async function writePending({ owner, sessionId, messageId, update }: PendingWrite): Promise<void> {
  const { userId, authEpoch } = owner;
  if (userId === '' || sessionId === '' || messageId === '') {
    return;
  }
  try {
    await chainSave(pendingSendChainKey(userId, sessionId), async () => {
      // Early exit, and the fence for the queued case: a write that chained
      // behind another one must not proceed once teardown has started.
      if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      const existing = await readPendingSendConfirmations(userId, sessionId);
      const next = update(existing);
      const scope = readCacheScope(userId);
      // The fence is re-read after the awaited read and before the write, with
      // no await in between: sign-out flips its flag and bumps the epoch
      // synchronously, before it clears `cache:<userId>:`, so a read that
      // resolved past that moment must not repopulate the scope teardown just
      // cleared.
      if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      if (next.length === 0) {
        await encryptedKv.removeItem(scope, pendingSendKey(sessionId));
        return;
      }
      await encryptedKv.setItem(scope, pendingSendKey(sessionId), JSON.stringify(next));
      await evictOldestSessions(scope);
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
  await writePending({
    ...input,
    update: existing =>
      existing.some(entry => entry.messageId === messageId)
        ? existing
        : [...existing, { messageId, text }].slice(-PENDING_SEND_MAX_IDS),
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
      existing.some(entry => entry.messageId === messageId)
        ? existing.filter(entry => entry.messageId !== messageId)
        : existing,
  });
}
