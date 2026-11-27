import { createHash } from 'node:crypto';
import type { RevocationListWire } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { REVOCATION_KINDS } from '../db/enums';

type RevocationKind = (typeof REVOCATION_KINDS)[number];
type IdKind = Exclude<RevocationKind, 'subject'>;

/**
 * The most entries a feed object holds. A backfill that finds more refuses to sign a head, so no
 * verifier gets a list that leaves an entry out; the count stays far below it (README, "Revocation
 * feed").
 */
export const FEED_MAX_ENTRIES = 50_000;

const EpochMs = z.number().int().positive();

const ID_KINDS = REVOCATION_KINDS.filter((kind): kind is IdKind => kind !== 'subject');
const EntryShape = { id: z.string().min(1).max(255), revokedAt: EpochMs, expiresAt: EpochMs };

/**
 * One revocation-feed entry, as `uts.revocations` holds it (design 5.6), with times in epoch
 * milliseconds. A `subject` entry carries `revokedBefore`: the subject's tokens issued at or
 * before it are revoked. Every other kind names one revoked id. Every entry leaves the feed at
 * `expiresAt`.
 */
export const FeedEntrySchema = z.union([
  z.strictObject({
    ...EntryShape,
    kind: z.literal('subject'),
    revokedBefore: z.number().int().nonnegative(),
  }),
  z.strictObject({ ...EntryShape, kind: z.enum(ID_KINDS), revokedBefore: z.null() }),
]);
export type FeedEntry = z.infer<typeof FeedEntrySchema>;

/** A batch one statement hands to the feed objects; it crosses an RPC boundary, so it is parsed. */
export const FeedEntriesSchema = z.array(FeedEntrySchema).max(FEED_MAX_ENTRIES);

/** `uts.feed_entries_of_statement()` and the backfill read name the columns this way. */
export const StoredFeedEntrySchema = z
  .strictObject({
    kind: z.enum(REVOCATION_KINDS),
    id: z.string().min(1),
    revoked_before: EpochMs.nullable(),
    revoked_at: EpochMs,
    expires_at: EpochMs,
  })
  .transform(row => ({
    kind: row.kind,
    id: row.id,
    revokedBefore: row.revoked_before,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  }))
  .pipe(FeedEntrySchema);

export const StatementFeedEntriesSchema = z.array(StoredFeedEntrySchema);

/** Entries keyed by kind and id, as the table's unique key names them. */
export type FeedEntries = Map<string, FeedEntry>;

function entryKey(entry: FeedEntry): string {
  return `${entry.kind}\u0000${entry.id}`;
}

/**
 * Adds `entry`, or raises the held entry's `revokedBefore`, `revokedAt` and `expiresAt` to the
 * later of both, so an entry never loses ground to an older copy of itself (a backfill can bring
 * an entry a publish already brought). Returns whether the held entries changed.
 */
export function mergeEntry(entries: FeedEntries, entry: FeedEntry): boolean {
  const key = entryKey(entry);
  const held = entries.get(key);
  if (held === undefined) {
    entries.set(key, entry);
    return true;
  }
  const times = {
    revokedAt: Math.max(held.revokedAt, entry.revokedAt),
    expiresAt: Math.max(held.expiresAt, entry.expiresAt),
  };
  // The key includes the kind, so both are subject entries or neither is.
  const merged: FeedEntry =
    held.kind === 'subject' && entry.kind === 'subject'
      ? { ...held, ...times, revokedBefore: Math.max(held.revokedBefore, entry.revokedBefore) }
      : { ...held, ...times };
  if (
    merged.revokedBefore === held.revokedBefore &&
    merged.revokedAt === held.revokedAt &&
    merged.expiresAt === held.expiresAt
  ) {
    return false;
  }
  entries.set(key, merged);
  return true;
}

/** Drops every entry whose feed time ended at or before `now`; returns whether any left. */
export function dropExpired(entries: FeedEntries, now: number): boolean {
  let dropped = false;
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) {
      entries.delete(key);
      dropped = true;
    }
  }
  return dropped;
}

/** Which list field each entry kind feeds; a token's `sid` names a grant, family or session. */
const LIST_FIELD: Readonly<Record<IdKind, Exclude<keyof RevocationListWire, 'revoked_before'>>> = {
  session: 'revoked_sids',
  grant: 'revoked_sids',
  third_party_family: 'revoked_sids',
  sandbox_grant: 'revoked_sids',
  pat: 'revoked_pat_ids',
  bot_key: 'revoked_pat_ids',
  kid: 'revoked_kids',
  blocked_account: 'blocked_accounts',
};

/** The serialized list a head covers: its exact bytes and their base64url SHA-256. */
export type SerializedList = { text: string; hash: string };

/**
 * The list of `entries` in one canonical form: every id array sorted and free of repeats, the
 * `revoked_before` members in ascending key order, written by hand so that no engine rule on
 * integer-like keys reorders them. Equal entry sets give equal bytes in both feed objects, so
 * their heads name the same hash. `revoked_before` is the subject's time in whole seconds, rounded
 * down, so every token issued before it, whose `iat` is rounded down too, compares at or before it.
 */
export function serializeList(entries: Iterable<FeedEntry>): SerializedList {
  const revokedBefore = new Map<string, number>();
  const ids: Record<Exclude<keyof RevocationListWire, 'revoked_before'>, Set<string>> = {
    revoked_sids: new Set(),
    revoked_kids: new Set(),
    revoked_pat_ids: new Set(),
    blocked_accounts: new Set(),
  };
  for (const entry of entries) {
    if (entry.kind === 'subject') {
      const seconds = Math.floor(entry.revokedBefore / 1000);
      revokedBefore.set(entry.id, Math.max(revokedBefore.get(entry.id) ?? 0, seconds));
    } else {
      ids[LIST_FIELD[entry.kind]].add(entry.id);
    }
  }
  const sorted = (values: Iterable<string>) => [...values].sort();
  const members = sorted(revokedBefore.keys()).map(
    subject => `${JSON.stringify(subject)}:${String(revokedBefore.get(subject))}`
  );
  const text =
    `{"revoked_before":{${members.join(',')}}` +
    `,"revoked_sids":${JSON.stringify(sorted(ids.revoked_sids))}` +
    `,"revoked_kids":${JSON.stringify(sorted(ids.revoked_kids))}` +
    `,"revoked_pat_ids":${JSON.stringify(sorted(ids.revoked_pat_ids))}` +
    `,"blocked_accounts":${JSON.stringify(sorted(ids.blocked_accounts))}}`;
  return { text, hash: createHash('sha256').update(text, 'utf8').digest('base64url') };
}
