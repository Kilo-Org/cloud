import { z } from 'zod';

import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { chainSave } from '@/lib/hooks/save-chain';
import * as encryptedKv from '@/lib/persist/encrypted-kv';
import { readCacheScope } from '@/lib/persist/read-cache';

/**
 * Bounded, per-user memory of delivery failures the user already resolved by
 * retrying, keyed by session. The SDK clears the failed footer locally when a
 * retry is accepted, but the Durable Object replays its stored events on the
 * next open — including the original `cloud.message.failed` — so without this
 * the footer returns after a relaunch (`MUST stop showing after a successful
 * retry`, `.specs/cloud-agent-session.md` Errors 3).
 *
 * Scope and retirement reuse the read cache: the blob lives in
 * `readCacheScope(userId)`, so sign-out's `cache:<userId>:` prefix clear
 * removes it and a `SCHEMA_VERSION` bump retires it without extra cleanup. The
 * item key is `resolved-delivery:<sessionId>`.
 *
 * Every failure is swallowed: this is a footer-suppression hint, never a
 * source of truth, so an unreadable or unwritable entry must never affect the
 * open or the retry path.
 */

/** At most this many resolved ids per session; the oldest are evicted. */
export const RESOLVED_DELIVERY_MAX_IDS = 100;

/**
 * At most this many sessions keep a recorded resolution per user. Like the
 * transcript cache, the scope is otherwise cleared only on sign-out, so
 * without a cap a long-lived install would accumulate one entry per session
 * the user ever retried.
 */
export const RESOLVED_DELIVERY_MAX_SESSIONS = 20;

const RESOLVED_DELIVERY_KEY_PREFIX = 'resolved-delivery:';

const resolvedIdsSchema = z.array(z.string().min(1));

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
 * Drops the oldest session entries beyond the cap for this key family only;
 * the read-cache blob and transcript pages in the same scope are untouched.
 * `listEntries` is ascending by `updatedAt`.
 */
async function evictOldestSessions(scope: string): Promise<void> {
  const entries = await encryptedKv.listEntries(scope);
  const resolved = entries.filter(entry => entry.k.startsWith(RESOLVED_DELIVERY_KEY_PREFIX));
  const excess = resolved.length - RESOLVED_DELIVERY_MAX_SESSIONS;
  if (excess <= 0) {
    return;
  }
  await Promise.all(
    resolved.slice(0, excess).map(async entry => {
      await encryptedKv.removeItem(scope, entry.k);
    })
  );
}

/** Reads the resolved delivery-failure ids for a session; `[]` on any miss. */
export async function readResolvedDeliveryFailures(
  userId: string,
  sessionId: string
): Promise<readonly string[]> {
  if (userId === '' || sessionId === '') {
    return [];
  }
  try {
    const raw = await encryptedKv.getItem(readCacheScope(userId), resolvedDeliveryKey(sessionId));
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    const result = resolvedIdsSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
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
  try {
    await chainSave(resolvedDeliveryChainKey(userId, sessionId), async () => {
      // Early exit, and the fence for the queued case: a write that chained
      // behind another one must not proceed once teardown has started.
      if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      const existing = await readResolvedDeliveryFailures(userId, sessionId);
      if (existing.includes(messageId)) {
        return;
      }
      const next = [...existing, messageId].slice(-RESOLVED_DELIVERY_MAX_IDS);
      const scope = readCacheScope(userId);
      // The fence is re-read after the awaited read and before the write, with
      // no await in between: sign-out flips its flag and bumps the epoch
      // synchronously, before it clears `cache:<userId>:`, so a read that
      // resolved past that moment must not repopulate the scope teardown just
      // cleared. Same fence as `session-transcript-cache.ts`.
      if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      await encryptedKv.setItem(scope, resolvedDeliveryKey(sessionId), JSON.stringify(next));
      await evictOldestSessions(scope);
    });
  } catch {
    // A failed write costs one restored footer, never a broken retry.
  }
}
