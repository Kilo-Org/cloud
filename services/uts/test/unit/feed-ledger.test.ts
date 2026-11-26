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
  FEED_RECENT_READ_MAX_GAP_MS,
  FEED_RECENT_WINDOW_MS,
  FeedLedger,
  type HeadSigner,
  type SignedHead,
} from '../../src/feed/ledger';
import { FEED_MAX_ENTRIES, type FeedEntry } from '../../src/revocation/entries';

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
    // A publish changes the list; the head is signed again, still dated by the backfill.
    ledger.take([grant('g-1')], T0 + 21_000);
    const published = await signed(ledger, T0 + 21_000);
    expect(published.issuedAt).toBe(T0 / 1000);
    expect(published.listHash).not.toBe(first.listHash);
    // Only a good backfill moves the date forward.
    backfill(ledger, T0 + 25_000);
    expect((await signed(ledger, T0 + 26_000)).issuedAt).toBe((T0 + 25_000) / 1000);
  });

  it('keeps the held head while its list and backfill stand', async () => {
    const ledger = backfilled();
    const first = await signed(ledger, T0);
    expect(await signed(ledger, T0 + 10_000)).toBe(first);
  });

  it('does not keep a head signed for a list that changed while it was signed', async () => {
    const ledger = backfilled();
    const signing = ledger.head(signer, T0);
    ledger.take([grant('g-1')], T0);
    const stale = await signing;
    const next = await signed(ledger, T0 + 1);
    expect(stale.status === 'signed' && stale.head.listHash).not.toBe(next.listHash);
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

  it('keeps every list for 30 seconds after it was replaced, at more than 4 changes per second', async () => {
    const ledger = backfilled();
    const hashes: string[] = [];
    // 40 changes in 4 seconds: 10 per second.
    for (let step = 0; step < 40; step += 1) {
      const at = T0 + step * 100;
      ledger.take([grant(`g-${step}`)], at);
      hashes.push((await signed(ledger, at)).listHash);
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
