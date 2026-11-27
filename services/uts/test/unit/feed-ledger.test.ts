import {
  FEED_HEAD_TYPE,
  FeedHeadPayloadSchema,
  feedKid,
  feedListHash,
  RevocationListWireSchema,
} from '@kilocode/uts-contracts';
import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FEED_BACKFILL_MAX_AGE_MS,
  FEED_BACKFILL_STALL_MS,
  FEED_EXPIRY_INTERVAL_MS,
  FEED_LIST_KEEP_MS,
  FEED_MAX_OLD_LIST_BYTES,
  FEED_RECENT_READ_MAX_GAP_MS,
  FEED_RECENT_WINDOW_MS,
  FeedLedger,
  type HeadSigner,
  type SignedHead,
} from '../../src/feed/ledger';
import { FEED_MAX_ENTRIES, type FeedEntry, serializeList } from '../../src/revocation/entries';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

const grant = (id: string, expiresAt = T0 + 20 * MINUTE): FeedEntry => ({
  kind: 'grant',
  id,
  revokedBefore: null,
  revokedAt: T0,
  expiresAt,
});

let signer: HeadSigner;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  const kid = feedKid(
    0,
    await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: String(jwk.x) })
  );
  signer = { kid, signingKey: pair.privateKey };
  publicKey = pair.publicKey;
});

/** A ledger whose first backfill, started at `at`, found `entries`. */
function backfilled(entries: readonly FeedEntry[] = [], at = T0): FeedLedger {
  const ledger = new FeedLedger();
  expect(ledger.startBackfill(at)).toEqual({ kind: 'all' });
  ledger.endBackfill(at, entries, at);
  return ledger;
}

/** One good backfill started at `at` that found `entries`. */
function backfill(ledger: FeedLedger, at: number, entries: readonly FeedEntry[] = []): void {
  expect(ledger.startBackfill(at)).not.toBeNull();
  ledger.endBackfill(at, entries, at);
}

async function signed(ledger: FeedLedger, now: number): Promise<SignedHead> {
  const answer = await ledger.head(signer, now);
  if (answer.status !== 'signed') throw new Error('head refused');
  return answer.head;
}

async function verified(compact: string) {
  const { payload } = await compactVerify(compact, publicKey);
  return FeedHeadPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
}

const sidsOf = (ledger: FeedLedger, head: SignedHead, now: number) =>
  RevocationListWireSchema.parse(JSON.parse(ledger.list(head.listHash, now)?.text ?? ''))
    .revoked_sids;

describe('vouching', () => {
  it('signs nothing before its first good backfill or after a failed one', async () => {
    const ledger = new FeedLedger();
    expect(await ledger.head(signer, T0)).toEqual({ status: 'refused' });
    ledger.startBackfill(T0);
    ledger.endBackfill(T0, null, T0);
    expect(ledger.vouches(T0)).toBe(false);
  });

  it('vouches for 30 seconds after the start of its last good backfill', () => {
    const ledger = backfilled();
    expect(ledger.vouches(T0 + FEED_BACKFILL_MAX_AGE_MS - 1)).toBe(true);
    expect(ledger.vouches(T0 + FEED_BACKFILL_MAX_AGE_MS)).toBe(false);
  });

  it('never moves the last good time back for a read that ends late', () => {
    const ledger = backfilled();
    const late = T0 + FEED_BACKFILL_STALL_MS;
    expect(ledger.startBackfill(late)).not.toBeNull();
    ledger.endBackfill(late, [], late);
    ledger.endBackfill(T0 + 1, [], late);
    expect(ledger.vouches(late + FEED_BACKFILL_MAX_AGE_MS - 1)).toBe(true);
  });

  it('refuses to sign while it holds more entries than the cap', async () => {
    const many = Array.from({ length: FEED_MAX_ENTRIES + 1 }, (_, index) => grant(`g-${index}`));
    const ledger = backfilled(many);
    expect(ledger.vouches(T0)).toBe(false);
    expect(await ledger.head(signer, T0)).toEqual({ status: 'refused' });
  });
});

describe('startBackfill', () => {
  it('admits one read at a time until it stalls', () => {
    const ledger = new FeedLedger();
    expect(ledger.startBackfill(T0)).toEqual({ kind: 'all' });
    expect(ledger.startBackfill(T0 + FEED_BACKFILL_STALL_MS - 1)).toBeNull();
    expect(ledger.startBackfill(T0 + FEED_BACKFILL_STALL_MS)).toEqual({ kind: 'all' });
  });

  it('reads the last 20 minutes after a recent good read, and everything after a long gap', () => {
    const ledger = backfilled();
    const next = T0 + 5000;
    expect(ledger.startBackfill(next)).toEqual({
      kind: 'recent',
      since: new Date(next - FEED_RECENT_WINDOW_MS),
    });
    ledger.endBackfill(next, null, next);
    const gap = T0 + FEED_RECENT_READ_MAX_GAP_MS;
    expect(ledger.startBackfill(gap)).toEqual({ kind: 'all' });
  });
});

describe('heads', () => {
  it('signs an EdDSA head of the feed type under the feed kid over the current list', async () => {
    const ledger = backfilled([grant('g-1')], T0 + 1500);
    const head = await signed(ledger, T0 + 4000);
    expect(decodeProtectedHeader(head.compact)).toEqual({
      alg: 'EdDSA',
      typ: FEED_HEAD_TYPE,
      kid: signer.kid,
    });
    expect(await verified(head.compact)).toEqual({
      iat: (T0 + 1000) / 1000,
      list_hash: head.listHash,
    });
    const list = ledger.list(head.listHash, T0 + 4000);
    expect(await feedListHash(new Uint8Array(new TextEncoder().encode(list?.text)))).toBe(
      head.listHash
    );
  });

  it('dates a head by its last good backfill, not by when it is signed', async () => {
    const ledger = backfilled([], T0);
    const first = await signed(ledger, T0 + 20_000);
    expect(first.issuedAt).toBe(T0 / 1000);
    // Only a good backfill moves the date forward.
    backfill(ledger, T0 + 25_000);
    expect((await signed(ledger, T0 + 26_000)).issuedAt).toBe((T0 + 25_000) / 1000);
  });

  it('never signs another list under a date it already signed, and asks for the backfill that dates the new list', async () => {
    // A verifier that holds a head refuses a head of the same second over another list, so a
    // publish that changes the list keeps the held head until a backfill that started in a later
    // second dates a head for the new list.
    const ledger = backfilled([], T0 + 200);
    const first = await signed(ledger, T0 + 300);
    expect(ledger.backfillWantedAt(T0 + 300)).toBeNull();
    ledger.take([grant('g-1')], T0 + 400);
    expect(await signed(ledger, T0 + 400)).toEqual(first);
    expect(ledger.backfillWantedAt(T0 + 400)).toBe(T0 + 1000);
    backfill(ledger, T0 + 900);
    expect(await signed(ledger, T0 + 900)).toEqual(first);
    expect(ledger.backfillWantedAt(T0 + 900)).toBe(T0 + 1000);
    backfill(ledger, T0 + 1000);
    const next = await signed(ledger, T0 + 1000);
    expect(next.issuedAt).toBe(first.issuedAt + 1);
    expect(sidsOf(ledger, next, T0 + 1000)).toEqual(['g-1']);
    expect(ledger.backfillWantedAt(T0 + 1000)).toBeNull();
    // The held head's list stays readable while that head is served.
    expect(ledger.list(first.listHash, T0 + 1000)).not.toBeNull();
  });

  it('signs a changed list under the same date while no head of that date went out', async () => {
    const ledger = backfilled([], T0);
    ledger.take([grant('g-1')], T0 + 100);
    expect(ledger.backfillWantedAt(T0 + 100)).toBeNull();
    const head = await signed(ledger, T0 + 100);
    expect(head.issuedAt).toBe(T0 / 1000);
    expect(sidsOf(ledger, head, T0 + 100)).toEqual(['g-1']);
  });

  it('keeps the held head while its list and backfill stand', async () => {
    const ledger = backfilled();
    const first = await signed(ledger, T0);
    expect(await signed(ledger, T0 + 10_000)).toBe(first);
  });

  it('signs no second list under one date, even when the list changes while a head is signed', async () => {
    const ledger = backfilled();
    const signing = ledger.head(signer, T0);
    ledger.take([grant('g-1')], T0);
    const first = await signing;
    const next = await signed(ledger, T0 + 1);
    expect(first.status === 'signed' && first.head.listHash).toBe(next.listHash);
    expect(ledger.list(next.listHash, T0 + 1)).not.toBeNull();
  });

  it('lets no switch between objects drop an entry committed before the newer head', async () => {
    // Object A got the entry by publish; object B missed the publish. Every revocation committed
    // before a backfill starts is in what that backfill reads, so B's next good backfill carries
    // it, and B's head is dated by that backfill.
    const committedAt = T0 + 2000;
    const entry = { ...grant('missed'), revokedAt: committedAt };
    const a = backfilled([], T0);
    const b = backfilled([], T0);
    a.take([entry], committedAt);
    const headA = await signed(a, committedAt);
    const before = await signed(b, committedAt);
    // B's head without the entry is no newer than the commit: a verifier holding A's head keeps
    // the entry until B's iat passes the commit, and then B has it.
    expect(before.issuedAt * 1000).toBeLessThan(committedAt);
    expect(before.issuedAt).toBeLessThanOrEqual(headA.issuedAt);
    backfill(b, T0 + 5000, [entry]);
    const after = await signed(b, T0 + 5000);
    expect(after.issuedAt * 1000).toBeGreaterThanOrEqual(committedAt);
    expect(sidsOf(b, after, T0 + 5000)).toContain('missed');
  });
});

describe('lists', () => {
  it('takes live entries only and serves each list by its hash', async () => {
    const ledger = backfilled([grant('g-1'), grant('expired', T0)]);
    const head = await signed(ledger, T0);
    expect(sidsOf(ledger, head, T0)).toEqual(['g-1']);
    expect(ledger.list('not a hash', T0)).toBeNull();
    expect(ledger.list('A'.repeat(43), T0)).toBeNull();
  });

  it('drops the oldest kept lists first once their text passes 16 MB', async () => {
    // Each step adds about 2.3 MB of ids (45,000 entries in all, under the 50,000 cap), so the lists
    // are about 2.3, 4.5, 6.8, 9.1 and 11.3 MB. With the last one current, the 9.1 and 6.8 MB lists
    // fit under the bound beside it and the two oldest go.
    const big = (step: number) =>
      Array.from({ length: 9_000 }, (_, index) => grant(`${step}-${index}-${'x'.repeat(240)}`));
    const ledger = backfilled();
    const held: FeedEntry[] = [];
    const hashes: string[] = [];
    for (let step = 0; step < 5; step += 1) {
      const entries = big(step);
      held.push(...entries);
      ledger.take(entries, T0 + step);
      hashes.push(serializeList(held).hash);
    }
    const now = T0 + 10;
    expect(hashes.map(hash => ledger.list(hash, now) !== null)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    const heldBytes = hashes
      .slice(2, 4)
      .reduce((total, hash) => total + (ledger.list(hash, now)?.text.length ?? 0), 0);
    expect(heldBytes).toBeLessThanOrEqual(FEED_MAX_OLD_LIST_BYTES);
  });

  it('keeps more than 64 small lists while they fit the byte bound', async () => {
    const ledger = backfilled();
    const held: FeedEntry[] = [];
    const hashes: string[] = [];
    // 100 changes in 10 seconds; each list is far under the byte bound.
    for (let step = 0; step < 100; step += 1) {
      const at = T0 + step * 100;
      const entry = grant(`many-${step}`);
      held.push(entry);
      ledger.take([entry], at);
      hashes.push(serializeList(held).hash);
    }
    const now = T0 + 10_000;
    expect(hashes.filter(hash => ledger.list(hash, now) !== null)).toHaveLength(100);
  });

  it('keeps every list for 30 seconds after it was replaced, at more than 4 changes per second', async () => {
    const ledger = backfilled();
    const held: FeedEntry[] = [];
    const hashes: string[] = [];
    // 40 changes in 4 seconds: 10 per second.
    for (let step = 0; step < 40; step += 1) {
      const at = T0 + step * 100;
      const entry = grant(`g-${step}`);
      held.push(entry);
      ledger.take([entry], at);
      hashes.push(serializeList(held).hash);
    }
    const now = T0 + 4000;
    for (const hash of hashes) expect(ledger.list(hash, now)).not.toBeNull();
    const replaced = hashes[0] ?? '';
    expect(ledger.list(replaced, T0 + 100 + FEED_LIST_KEEP_MS - 1)).not.toBeNull();
    expect(ledger.list(replaced, T0 + 100 + FEED_LIST_KEEP_MS)).toBeNull();
  });

  it('drops expired entries at most once a minute, so expiries do not churn the list', () => {
    const ledger = backfilled([grant('a', T0 + MINUTE), grant('b', T0 + MINUTE + 5000)]);
    expect(ledger.expire(T0 + MINUTE)).toBe(true);
    expect(ledger.expire(T0 + MINUTE + 5000)).toBe(false);
    expect(ledger.expire(T0 + MINUTE + FEED_EXPIRY_INTERVAL_MS)).toBe(true);
    expect(ledger.expire(T0 + 3 * MINUTE + FEED_EXPIRY_INTERVAL_MS)).toBe(false);
  });

  it('reports a change only when the list changes', () => {
    const ledger = backfilled([grant('g-1')]);
    expect(ledger.take([grant('g-1')], T0)).toBe(false);
    expect(ledger.take([grant('g-2')], T0)).toBe(true);
  });
});
