import type { IdentityStore } from '../db/client';
import { FEED_MAX_ENTRIES, type FeedEntry, StoredFeedEntrySchema } from './entries';

/**
 * The feed objects' backfill read (design 5.6): the live entries of `uts.revocations`, as the app
 * login, which holds SELECT on the table. Each read is one statement.
 * * `recent` reads the entries revoked at or after `since` (the last 20 minutes) through
 *   `revocations_revoked_at_idx`.
 * * `all` reads every entry still in the feed through `revocations_feed_expires_idx`; a feed
 *   object runs it when it has no recent good read, after a restart or a long outage.
 * Each read asks for one row more than a feed object holds, so a read that finds too many entries
 * is told apart from a full one.
 */
export type FeedEntriesRead = { kind: 'recent'; since: Date } | { kind: 'all' };

export type FeedEntriesResult =
  | { status: 'read'; entries: FeedEntry[] }
  | { status: 'too_many'; limit: number };

const COLUMNS = `kind, subject_id AS id,
  floor(extract(epoch FROM revoked_before) * 1000)::float8 AS revoked_before,
  floor(extract(epoch FROM revoked_at) * 1000)::float8 AS revoked_at,
  floor(extract(epoch FROM feed_expires_at) * 1000)::float8 AS expires_at`;

export const RECENT_FEED_ENTRIES = `SELECT ${COLUMNS} FROM uts.revocations
  WHERE revoked_at >= $1 AND feed_expires_at > now() LIMIT $2`;

export const ALL_FEED_ENTRIES = `SELECT ${COLUMNS} FROM uts.revocations
  WHERE feed_expires_at > now() LIMIT $1`;

export async function readFeedEntries(
  store: IdentityStore,
  read: FeedEntriesRead
): Promise<FeedEntriesResult> {
  const limit = FEED_MAX_ENTRIES + 1;
  const statement =
    read.kind === 'recent'
      ? { text: RECENT_FEED_ENTRIES, values: [read.since, limit] }
      : { text: ALL_FEED_ENTRIES, values: [limit] };
  const entries = await store.rows(statement, StoredFeedEntrySchema);
  if (entries.length > FEED_MAX_ENTRIES) return { status: 'too_many', limit: FEED_MAX_ENTRIES };
  return { status: 'read', entries };
}
