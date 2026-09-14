import { type SessionSnapshotPage } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import * as encryptedKv from '@/lib/persist/encrypted-kv';
import { readCacheScope } from '@/lib/persist/read-cache';
import { utf8ByteLength } from '@/lib/utf8-utils';

/**
 * Bounded, per-user cache of a session's first transcript page (the newest
 * messages), so a warm open paints content before the live snapshot refresh
 * settles.
 *
 * Scope and retirement reuse the read cache: the blob lives in
 * `readCacheScope(userId)` (`cache:<userId>:<SCHEMA_VERSION>`), so sign-out's
 * `cache:<userId>:` prefix clear removes it and a `SCHEMA_VERSION` bump
 * retires it without any extra cleanup. The item key is
 * `transcript:<sessionId>`.
 *
 * Writes share the read cache's publication fence: an epoch captured when the
 * owning session manager was created must still be current and no sign-out may
 * be in progress, so a page that resolves after teardown cannot repopulate the
 * scope sign-out just cleared. The number of sessions is bounded by
 * {@link SESSION_TRANSCRIPT_MAX_ENTRIES}; the oldest entries are evicted after
 * each write.
 *
 * The blob is JSON. A page larger than {@link SESSION_TRANSCRIPT_MAX_BYTES} is
 * dropped instead of written (the previous entry is removed), and every
 * failure is swallowed: this is a warm-start optimization, never a source of
 * truth, so it must never affect the open path.
 */

export const SESSION_TRANSCRIPT_MAX_BYTES = 512 * 1024;

/**
 * At most this many sessions keep a cached first page per user. The read cache
 * is cleared only on sign-out, so without a cap a long-lived install would
 * accumulate one entry per session it ever opened.
 */
export const SESSION_TRANSCRIPT_MAX_ENTRIES = 10;

const TRANSCRIPT_KEY_PREFIX = 'transcript:';

// Decode at the I/O boundary (the KV is encrypted but still untrusted storage
// after a restore). Only the fields the SDK reads before replay are validated;
// the original parsed value is returned so message payloads survive intact.
const sessionTranscriptPageSchema = z.object({
  info: z.object({ id: z.string() }),
  messages: z.array(z.object({ parts: z.array(z.unknown()) })),
  nextCursor: z.string().nullable(),
  omittedItemCount: z.number(),
});

function transcriptItemKey(sessionId: string): string {
  return `${TRANSCRIPT_KEY_PREFIX}${sessionId}`;
}

/** Reads the cached first page, or null when absent, malformed, or unreadable. */
export async function readSessionTranscriptPage(
  userId: string,
  sessionId: string
): Promise<SessionSnapshotPage | null> {
  if (userId === '' || sessionId === '') {
    return null;
  }
  try {
    const raw = await encryptedKv.getItem(readCacheScope(userId), transcriptItemKey(sessionId));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!sessionTranscriptPageSchema.safeParse(parsed).success) {
      return null;
    }
    return parsed as SessionSnapshotPage;
  } catch {
    // Any failure (missing key, parse error, KV unavailable) is a cache miss.
    return null;
  }
}

/**
 * Identity a transcript page is written under. `userId` scopes the entry;
 * `authEpoch` is captured when the owning session manager is created, so the
 * write can be refused once a sign-out/sign-in moves it.
 */
export type SessionTranscriptOwner = {
  userId: string;
  authEpoch: number;
};

/**
 * Writes the cached first page. A page over the byte budget is not stored: the
 * previous entry for the session is removed so a stale page cannot survive the
 * write that replaced it. Refused while sign-out is active or the owner's
 * `authEpoch` has moved, so a write that raced a sign-out cannot land in a
 * scope that teardown cleared. Never throws.
 */
export async function writeSessionTranscriptPage(
  owner: SessionTranscriptOwner,
  sessionId: string,
  page: SessionSnapshotPage
): Promise<void> {
  const { userId, authEpoch } = owner;
  if (userId === '' || sessionId === '') {
    return;
  }
  const scope = readCacheScope(userId);
  const key = transcriptItemKey(sessionId);
  try {
    // Publication fence, the same one `createReadCachePersister` applies:
    // sign-out flips its flag synchronously and bumps the epoch before the
    // scope is cleared, so a late write is refused either way.
    if (isSignOutActive() || !isCurrentAuthEpoch(authEpoch)) {
      return;
    }
    const serialized = JSON.stringify(page);
    if (utf8ByteLength(serialized) > SESSION_TRANSCRIPT_MAX_BYTES) {
      await encryptedKv.removeItem(scope, key);
      return;
    }
    await encryptedKv.setItem(scope, key, serialized);
    await evictOldestBeyondCap(scope);
  } catch {
    // Best effort: a cache write failure never affects the open path.
  }
}

/**
 * Keeps at most {@link SESSION_TRANSCRIPT_MAX_ENTRIES} transcripts in one
 * scope. Only `transcript:` keys are counted: the read-cache blob shares the
 * scope and must never be evicted by this cache. `listEntries` is oldest-first
 * by `updated_at`, so the oldest transcripts go first.
 */
async function evictOldestBeyondCap(scope: string): Promise<void> {
  const entries = await encryptedKv.listEntries(scope);
  const transcripts = entries.filter(entry => entry.k.startsWith(TRANSCRIPT_KEY_PREFIX));
  const overflow = transcripts.length - SESSION_TRANSCRIPT_MAX_ENTRIES;
  if (overflow <= 0) {
    return;
  }
  await Promise.all(
    transcripts.slice(0, overflow).map(async entry => {
      await encryptedKv.removeItem(scope, entry.k);
    })
  );
}

/** Removes one session's cached page. Never throws. */
export async function clearSessionTranscriptPage(userId: string, sessionId: string): Promise<void> {
  if (userId === '' || sessionId === '') {
    return;
  }
  try {
    await encryptedKv.removeItem(readCacheScope(userId), transcriptItemKey(sessionId));
  } catch {
    // Best effort.
  }
}
