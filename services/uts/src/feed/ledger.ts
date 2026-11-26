import { FeedListHashSchema } from '@kilocode/uts-contracts';
import {
  dropExpired,
  mergeEntry,
  serializeList,
  type FeedEntries,
  type FeedEntry,
  type SerializedList,
} from '../revocation/entries';
import type { FeedEntriesRead } from '../revocation/store';
import { signFeedHead } from './head';

/** A head older than this is signed again on the next read, so a served head is under 5 s old. */
export const FEED_HEAD_MAX_AGE_MS = 5 * 1000;

/** The backfill reads the entries revoked in the last 20 minutes (design 5.6). */
export const FEED_RECENT_WINDOW_MS = 20 * 60 * 1000;

/**
 * A backfill reads only the recent window while the last good read started less than this long
 * ago, so consecutive windows overlap by at least 5 minutes; after a restart or a longer outage it
 * reads every entry still in the feed.
 */
export const FEED_RECENT_READ_MAX_GAP_MS = 15 * 60 * 1000;

/**
 * A feed object signs heads only while its last good backfill started less than this long ago. A
 * write that reached neither object reaches the list through the backfill, so an object that
 * cannot backfill stops vouching for its list; the feed Worker then reads the other object, and
 * verifiers fall back to the head-age limits (design 5.6, 7).
 */
export const FEED_BACKFILL_MAX_AGE_MS = 60 * 1000;

/** A backfill that has not finished after this long no longer blocks the next one. */
export const FEED_BACKFILL_STALL_MS = 30 * 1000;

/** Lists kept by hash beside the current one, for a verifier that fetched a head just before. */
export const FEED_RECENT_LISTS = 4;

/** The key a head is signed with: the feed object's current key. */
export type HeadSigner = { kid: string; signingKey: CryptoKey };

export type SignedHead = { compact: string; listHash: string; issuedAt: number; signedAt: number };

type Backfill = { status: 'idle' } | { status: 'reading'; startedAt: number };

/**
 * One feed object's entries, lists and head, as plain data (design 5.6). The object holds no entry
 * in storage: the identity store is the record, and a new ledger signs no head before its first
 * good backfill.
 */
export class FeedLedger {
  readonly #entries: FeedEntries = new Map();
  #list: SerializedList = serializeList([]);
  #recentLists: SerializedList[] = [];
  #head: SignedHead | null = null;
  #backfill: Backfill = { status: 'idle' };
  /** When the last good backfill started; null until one succeeds. */
  #lastGoodBackfillAt: number | null = null;

  /** Adds live entries; returns whether the list changed. */
  take(entries: readonly FeedEntry[], now: number): boolean {
    let changed = false;
    for (const entry of entries) {
      if (entry.expiresAt > now && mergeEntry(this.#entries, entry)) changed = true;
    }
    return changed && this.#rebuildList();
  }

  /** Drops expired entries; returns whether the list changed. */
  expire(now: number): boolean {
    return dropExpired(this.#entries, now) && this.#rebuildList();
  }

  /** Whether this object may sign a head: its last good backfill started under 60 s ago. */
  vouches(now: number): boolean {
    return (
      this.#lastGoodBackfillAt !== null && now - this.#lastGoodBackfillAt < FEED_BACKFILL_MAX_AGE_MS
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

  /** The list with this hash: the current one or one of the last few. */
  list(listHash: unknown): SerializedList | null {
    const hash = FeedListHashSchema.safeParse(listHash);
    if (!hash.success) return null;
    return [this.#list, ...this.#recentLists].find(held => held.hash === hash.data) ?? null;
  }

  /**
   * The held head while it covers the current list and is under 5 seconds old; otherwise a new
   * one. A head signed for a list that changed while it was signed is returned to its caller (it
   * was true when signed) but not kept, so the next read signs the newer list.
   */
  async head(signer: HeadSigner, now: number): Promise<SignedHead> {
    const held = this.#head;
    if (
      held !== null &&
      held.listHash === this.#list.hash &&
      now - held.signedAt < FEED_HEAD_MAX_AGE_MS
    ) {
      return held;
    }
    const listHash = this.#list.hash;
    const issuedAt = Math.floor(now / 1000);
    const compact = await signFeedHead(signer.signingKey, signer.kid, {
      iat: issuedAt,
      list_hash: listHash,
    });
    const signed: SignedHead = { compact, listHash, issuedAt, signedAt: now };
    const latest = this.#head;
    if (listHash === this.#list.hash && (latest === null || latest.signedAt <= now)) {
      this.#head = signed;
    }
    return signed;
  }

  #rebuildList(): boolean {
    const list = serializeList(this.#entries.values());
    if (list.hash === this.#list.hash) return false;
    this.#recentLists = [this.#list, ...this.#recentLists].slice(0, FEED_RECENT_LISTS);
    this.#list = list;
    return true;
  }
}
