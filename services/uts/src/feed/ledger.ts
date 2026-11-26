import { FeedListHashSchema } from '@kilocode/uts-contracts';
import {
  dropExpired,
  FEED_MAX_ENTRIES,
  mergeEntry,
  serializeList,
  type FeedEntries,
  type FeedEntry,
  type SerializedList,
} from '../revocation/entries';
import type { FeedEntriesRead } from '../revocation/store';
import { signFeedHead } from './head';

/** The backfill reads the entries revoked in the last 20 minutes (design 5.6). */
export const FEED_RECENT_WINDOW_MS = 20 * 60 * 1000;

/**
 * A backfill reads only the recent window while the last good read started less than this long
 * ago, so consecutive windows overlap by at least 5 minutes; after a restart or a longer outage it
 * reads every entry still in the feed.
 */
export const FEED_RECENT_READ_MAX_GAP_MS = 15 * 60 * 1000;

/**
 * A feed object signs heads only while its last good backfill started less than this long ago.
 * A head's `iat` is that backfill's start, so verifiers already refuse a head this old (30 s); this
 * bound only stops an object from signing heads nobody can use.
 */
export const FEED_BACKFILL_MAX_AGE_MS = 30 * 1000;

/** A backfill that has not finished after this long no longer blocks the next one. */
export const FEED_BACKFILL_STALL_MS = 30 * 1000;

/**
 * A list stays readable by its hash for this long after it stopped being current, so a verifier
 * that fetched a head from a data centre's cache (up to 5 s) or from an object that has moved on
 * still gets its list, however fast the list changes.
 */
export const FEED_LIST_KEEP_MS = 30 * 1000;

/**
 * Memory bounds of the old lists, oldest dropped first: at most this many lists, and at most
 * `FEED_MAX_OLD_LIST_BYTES` of list text in all. At the 50,000-entry cap one list is a few
 * megabytes, so the byte bound decides there; at the design's rates the list changes well under
 * once per second and both bounds stay far away.
 */
export const FEED_MAX_OLD_LISTS = 64;
export const FEED_MAX_OLD_LIST_BYTES = 16 * 1024 * 1024;

/**
 * Expired entries leave the list at most this often. An expired entry left in the list is
 * harmless, because the tokens it names are past their expiry, and each removal is a new list that
 * every data centre fetches again (design 3, "Revocation feed").
 */
export const FEED_EXPIRY_INTERVAL_MS = 60 * 1000;

/** The key a head is signed with: the feed object's current key. */
export type HeadSigner = { kid: string; signingKey: CryptoKey };

export type SignedHead = { compact: string; listHash: string; issuedAt: number };

/** `refused`: the object holds no fresh backfill, or more entries than the cap. */
export type HeadAnswer = { status: 'signed'; head: SignedHead } | { status: 'refused' };

type Backfill = { status: 'idle' } | { status: 'reading'; startedAt: number };

type OldList = { list: SerializedList; replacedAt: number; bytes: number };

/**
 * One feed object's entries, lists and head, as plain data (design 5.6). The object holds no entry
 * in storage: the identity store is the record, and a new ledger signs no head before its first
 * good backfill.
 *
 * A head's `iat` is the start of the last good backfill, rounded down to whole seconds, not the
 * time it was signed: every revocation committed before `iat` is in the list it names, because
 * that backfill read every entry committed before it started. So `iat` advances only with a good
 * backfill, a verifier's head-age limit measures how current the list is, and a verifier that
 * moves to the other object's head (whose `iat` is not older) loses no entry committed before it.
 * Entries a publish adds after that point are in the list too; the head is signed again for each
 * new list or backfill.
 */
export class FeedLedger {
  readonly #entries: FeedEntries = new Map();
  #list: SerializedList = serializeList([]);
  #oldLists: OldList[] = [];
  #head: SignedHead | null = null;
  #backfill: Backfill = { status: 'idle' };
  /** When the last good backfill started; null until one succeeds. */
  #lastGoodBackfillAt: number | null = null;
  #lastExpiryAt = 0;

  /** Adds live entries; returns whether the list changed. */
  take(entries: readonly FeedEntry[], now: number): boolean {
    let changed = false;
    for (const entry of entries) {
      if (entry.expiresAt > now && mergeEntry(this.#entries, entry)) changed = true;
    }
    return changed && this.#rebuildList(now);
  }

  /**
   * Drops expired entries, at most once per minute; returns whether the list changed. Old lists
   * past their keep time leave here too.
   */
  expire(now: number): boolean {
    this.#oldLists = this.#oldLists.filter(old => now - old.replacedAt < FEED_LIST_KEEP_MS);
    if (now - this.#lastExpiryAt < FEED_EXPIRY_INTERVAL_MS) return false;
    this.#lastExpiryAt = now;
    return dropExpired(this.#entries, now) && this.#rebuildList(now);
  }

  /**
   * Whether this object may sign a head: its last good backfill started under 30 s ago, and it
   * holds no more entries than the cap (a list it cannot hold whole is never vouched for).
   */
  vouches(now: number): boolean {
    return (
      this.#lastGoodBackfillAt !== null &&
      now - this.#lastGoodBackfillAt < FEED_BACKFILL_MAX_AGE_MS &&
      this.#entries.size <= FEED_MAX_ENTRIES
    );
  }

  /**
   * Claims the next backfill, or null while another one runs and has not stalled: one admission
   * check before the read starts, so two alarms never read at once. The read is the recent window
   * while the last good one is recent enough, and every live entry otherwise.
   */
  startBackfill(now: number): FeedEntriesRead | null {
    const running = this.#backfill;
    if (running.status === 'reading' && now - running.startedAt < FEED_BACKFILL_STALL_MS) {
      return null;
    }
    this.#backfill = { status: 'reading', startedAt: now };
    const last = this.#lastGoodBackfillAt;
    return last !== null && now - last < FEED_RECENT_READ_MAX_GAP_MS
      ? { kind: 'recent', since: new Date(now - FEED_RECENT_WINDOW_MS) }
      : { kind: 'all' };
  }

  /**
   * Ends the backfill that started at `startedAt`. A good one adds its entries and moves the last
   * good time forward, never back past a read that started later; entries only grow until they
   * expire, so a read that ends late merges harmlessly. A stalled read that ends after its
   * successor started leaves the successor's claim in place.
   */
  endBackfill(startedAt: number, entries: readonly FeedEntry[] | null, now: number): void {
    if (entries !== null) {
      this.take(entries, now);
      if (this.#lastGoodBackfillAt === null || startedAt > this.#lastGoodBackfillAt) {
        this.#lastGoodBackfillAt = startedAt;
      }
    }
    const current = this.#backfill;
    if (current.status === 'reading' && current.startedAt === startedAt) {
      this.#backfill = { status: 'idle' };
    }
  }

  /** The list with this hash: the current one or one replaced in the last 30 seconds. */
  list(listHash: unknown, now: number): SerializedList | null {
    const hash = FeedListHashSchema.safeParse(listHash);
    if (!hash.success) return null;
    if (this.#list.hash === hash.data) return this.#list;
    const old = this.#oldLists.find(
      held => held.list.hash === hash.data && now - held.replacedAt < FEED_LIST_KEEP_MS
    );
    return old?.list ?? null;
  }

  /**
   * The head for the current list as of the last good backfill: the held one while it names both,
   * otherwise a new one. A head signed for a list or backfill that changed while it was signed is
   * returned to its caller (it was true when signed) but not kept.
   */
  async head(signer: HeadSigner, now: number): Promise<HeadAnswer> {
    if (!this.vouches(now) || this.#lastGoodBackfillAt === null) return { status: 'refused' };
    const issuedAt = Math.floor(this.#lastGoodBackfillAt / 1000);
    const listHash = this.#list.hash;
    const held = this.#head;
    if (held !== null && held.listHash === listHash && held.issuedAt === issuedAt) {
      return { status: 'signed', head: held };
    }
    const compact = await signFeedHead(signer.signingKey, signer.kid, {
      iat: issuedAt,
      list_hash: listHash,
    });
    const signed: SignedHead = { compact, listHash, issuedAt };
    const latest = this.#head;
    if (listHash === this.#list.hash && (latest === null || latest.issuedAt <= issuedAt)) {
      this.#head = signed;
    }
    return { status: 'signed', head: signed };
  }

  #rebuildList(now: number): boolean {
    const list = serializeList(this.#entries.values());
    if (list.hash === this.#list.hash) return false;
    const replaced: OldList = {
      list: this.#list,
      replacedAt: now,
      bytes: new TextEncoder().encode(this.#list.text).byteLength,
    };
    const kept = [replaced, ...this.#oldLists].slice(0, FEED_MAX_OLD_LISTS);
    let bytes = kept.reduce((total, old) => total + old.bytes, 0);
    while (bytes > FEED_MAX_OLD_LIST_BYTES && kept.length > 0) {
      bytes -= kept.pop()?.bytes ?? 0;
    }
    this.#oldLists = kept;
    this.#list = list;
    return true;
  }
}
