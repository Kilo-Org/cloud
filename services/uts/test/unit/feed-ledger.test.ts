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
  FEED_HEAD_MAX_AGE_MS,
  FEED_RECENT_LISTS,
  FEED_RECENT_READ_MAX_GAP_MS,
  FEED_RECENT_WINDOW_MS,
  FeedLedger,
  type HeadSigner,
} from '../../src/feed/ledger';
import type { FeedEntry } from '../../src/revocation/entries';

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

async function verified(compact: string) {
  const { payload } = await compactVerify(compact, publicKey);
  return FeedHeadPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
}

describe('vouching', () => {
  it('signs nothing before its first good backfill or after a failed one', () => {
    const ledger = new FeedLedger();
    expect(ledger.vouches(T0)).toBe(false);
    ledger.startBackfill(T0);
    ledger.endBackfill(T0, null, T0);
    expect(ledger.vouches(T0)).toBe(false);
  });

  it('vouches for 60 seconds after the start of its last good backfill', () => {
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

describe('entries and lists', () => {
  it('takes live entries only and serves each list by its hash', async () => {
    const ledger = backfilled([grant('g-1'), grant('expired', T0)]);
    const head = await ledger.head(signer, T0);
    const list = ledger.list(head.listHash);
    expect(list).not.toBeNull();
    expect(RevocationListWireSchema.parse(JSON.parse(list?.text ?? '')).revoked_sids).toEqual([
      'g-1',
    ]);
    expect(await feedListHash(new Uint8Array(new TextEncoder().encode(list?.text)))).toBe(
      head.listHash
    );
    expect(ledger.list('not a hash')).toBeNull();
    expect(ledger.list('A'.repeat(43))).toBeNull();
  });

  it('keeps the last 4 lists beside the current one', async () => {
    const ledger = backfilled();
    const hashes = [(await ledger.head(signer, T0)).listHash];
    for (let step = 1; step <= FEED_RECENT_LISTS + 1; step += 1) {
      expect(ledger.take([grant(`g-${step}`)], T0)).toBe(true);
      hashes.push((await ledger.head(signer, T0)).listHash);
    }
    expect(ledger.list(hashes[0])).toBeNull();
    for (const hash of hashes.slice(1)) expect(ledger.list(hash)).not.toBeNull();
  });

  it('reports a change only when the list changes, and drops entries at their end', () => {
    const ledger = backfilled([grant('g-1', T0 + MINUTE)]);
    expect(ledger.take([grant('g-1', T0 + MINUTE)], T0)).toBe(false);
    expect(ledger.expire(T0 + MINUTE - 1)).toBe(false);
    expect(ledger.expire(T0 + MINUTE)).toBe(true);
  });
});

describe('heads', () => {
  it('signs an EdDSA head of the feed type under the feed kid over the current list', async () => {
    const ledger = backfilled([grant('g-1')]);
    const head = await ledger.head(signer, T0 + 1500);
    expect(decodeProtectedHeader(head.compact)).toEqual({
      alg: 'EdDSA',
      typ: FEED_HEAD_TYPE,
      kid: signer.kid,
    });
    expect(await verified(head.compact)).toEqual({
      iat: (T0 + 1000) / 1000,
      list_hash: head.listHash,
    });
    expect(head.issuedAt).toBe((T0 + 1000) / 1000);
  });

  it('keeps a head for 5 seconds, and signs a new one after that or when the list changes', async () => {
    const ledger = backfilled();
    const first = await ledger.head(signer, T0);
    expect(await ledger.head(signer, T0 + FEED_HEAD_MAX_AGE_MS - 1)).toBe(first);
    const aged = await ledger.head(signer, T0 + FEED_HEAD_MAX_AGE_MS);
    expect(aged).not.toBe(first);
    expect(aged.listHash).toBe(first.listHash);
    ledger.take([grant('g-1')], T0);
    const changed = await ledger.head(signer, T0 + FEED_HEAD_MAX_AGE_MS);
    expect(changed.listHash).not.toBe(first.listHash);
    expect((await verified(changed.compact)).list_hash).toBe(changed.listHash);
  });

  it('does not keep a head signed for a list that changed while it was signed', async () => {
    const ledger = backfilled();
    const signing = ledger.head(signer, T0);
    ledger.take([grant('g-1')], T0);
    const stale = await signing;
    const next = await ledger.head(signer, T0 + 1);
    expect(next).not.toBe(stale);
    expect(next.listHash).not.toBe(stale.listHash);
    expect(ledger.list(next.listHash)).not.toBeNull();
  });
});
