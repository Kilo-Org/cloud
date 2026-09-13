import { type SessionSnapshotPage } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

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
 * The blob is JSON. A page larger than {@link SESSION_TRANSCRIPT_MAX_BYTES} is
 * dropped instead of written (the previous entry is removed), and every
 * failure is swallowed: this is a warm-start optimization, never a source of
 * truth, so it must never affect the open path.
 */

export const SESSION_TRANSCRIPT_MAX_BYTES = 512 * 1024;

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
 * Writes the cached first page. A page over the byte budget is not stored: the
 * previous entry for the session is removed so a stale page cannot survive the
 * write that replaced it. Never throws.
 */
export async function writeSessionTranscriptPage(
  userId: string,
  sessionId: string,
  page: SessionSnapshotPage
): Promise<void> {
  if (userId === '' || sessionId === '') {
    return;
  }
  const scope = readCacheScope(userId);
  const key = transcriptItemKey(sessionId);
  try {
    const serialized = JSON.stringify(page);
    if (utf8ByteLength(serialized) > SESSION_TRANSCRIPT_MAX_BYTES) {
      await encryptedKv.removeItem(scope, key);
      return;
    }
    await encryptedKv.setItem(scope, key, serialized);
  } catch {
    // Best effort: a cache write failure never affects the open path.
  }
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
