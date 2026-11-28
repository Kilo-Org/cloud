import { createHash } from 'node:crypto';
import { RevocationListWireSchema } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import {
  dropExpired,
  FeedEntriesSchema,
  FeedEntrySchema,
  mergeEntry,
  serializeList,
  StatementFeedEntriesSchema,
  type FeedEntries,
  type FeedEntry,
} from '../../src/revocation/entries';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

function entry(overrides: Partial<FeedEntry> & Pick<FeedEntry, 'kind' | 'id'>): FeedEntry {
  const base = { revokedAt: T0, expiresAt: T0 + 20 * MINUTE };
  return overrides.kind === 'subject'
    ? { revokedBefore: T0, ...base, ...overrides }
    : { revokedBefore: null, ...base, ...overrides };
}

describe('feed entry schemas', () => {
  it('accept a subject entry with revokedBefore and an id entry without it', () => {
    expect(FeedEntrySchema.parse(entry({ kind: 'subject', id: 'user-a' }))).toMatchObject({
      revokedBefore: T0,
    });
    expect(FeedEntrySchema.parse(entry({ kind: 'grant', id: 'grant-a' }))).toMatchObject({
      revokedBefore: null,
    });
    expect(
      FeedEntrySchema.safeParse({ ...entry({ kind: 'grant', id: 'g' }), revokedBefore: T0 }).success
    ).toBe(false);
    expect(
      FeedEntrySchema.safeParse({ ...entry({ kind: 'subject', id: 's' }), revokedBefore: null })
        .success
    ).toBe(false);
    expect(FeedEntrySchema.safeParse({ ...entry({ kind: 'grant', id: '' }) }).success).toBe(false);
    expect(FeedEntriesSchema.safeParse([{ kind: 'unknown', id: 'x' }]).success).toBe(false);
  });

  it('read the columns the identity store returns', () => {
    expect(
      StatementFeedEntriesSchema.parse([
        { kind: 'grant', id: 'g-1', revoked_before: null, revoked_at: T0, expires_at: T0 + 1 },
        { kind: 'subject', id: 'u-1', revoked_before: T0 - 5, revoked_at: T0, expires_at: T0 + 1 },
      ])
    ).toEqual([
      { kind: 'grant', id: 'g-1', revokedBefore: null, revokedAt: T0, expiresAt: T0 + 1 },
      { kind: 'subject', id: 'u-1', revokedBefore: T0 - 5, revokedAt: T0, expiresAt: T0 + 1 },
    ]);
    expect(
      StatementFeedEntriesSchema.safeParse([
        { kind: 'pat', id: 'p', revoked_before: T0, revoked_at: T0, expires_at: T0 + 1 },
      ]).success
    ).toBe(false);
  });
});

describe('mergeEntry', () => {
  it('adds a new entry and raises a held one, never lowering it', () => {
    const entries: FeedEntries = new Map();
    expect(mergeEntry(entries, entry({ kind: 'subject', id: 'u' }))).toBe(true);
    expect(mergeEntry(entries, entry({ kind: 'subject', id: 'u' }))).toBe(false);
    const later = entry({
      kind: 'subject',
      id: 'u',
      revokedBefore: T0 + MINUTE,
      revokedAt: T0 + MINUTE,
      expiresAt: T0 + 30 * MINUTE,
    });
    expect(mergeEntry(entries, later)).toBe(true);
    expect(mergeEntry(entries, entry({ kind: 'subject', id: 'u' }))).toBe(false);
    expect([...entries.values()]).toEqual([later]);
  });

  it('keeps entries of different kinds with the same id apart', () => {
    const entries: FeedEntries = new Map();
    mergeEntry(entries, entry({ kind: 'grant', id: 'same' }));
    mergeEntry(entries, entry({ kind: 'session', id: 'same' }));
    expect(entries.size).toBe(2);
  });

  it('takes a block away on an unblock that is not older, and keeps it out until the unblock expires', () => {
    const entries: FeedEntries = new Map();
    const block = entry({ kind: 'blocked_account', id: 'user-b', expiresAt: T0 + 70 * MINUTE });
    const unblockAt = T0 + 2 * MINUTE;
    const unblock = entry({
      kind: 'unblocked_account',
      id: 'user-b',
      revokedAt: unblockAt,
      expiresAt: unblockAt + 20 * MINUTE,
    });
    expect(mergeEntry(entries, block)).toBe(true);
    expect(mergeEntry(entries, unblock)).toBe(true);
    const blockedOf = (held: FeedEntries) =>
      RevocationListWireSchema.parse(JSON.parse(serializeList(held.values()).text))
        .blocked_accounts;
    expect(blockedOf(entries)).toEqual([]);
    // A backfill that started before the unblock brings the old block, or the block the unblock
    // statement dated at its own time: neither comes back.
    expect(mergeEntry(entries, block)).toBe(false);
    const redated = { ...block, revokedAt: unblockAt, expiresAt: unblockAt + 10 * MINUTE };
    expect(mergeEntry(entries, redated)).toBe(false);
    expect(entries.has('blocked_account\u0000user-b')).toBe(false);
    // A block again, after the unblock, wins whichever arrives first.
    const again = entry({ kind: 'blocked_account', id: 'user-b', revokedAt: unblockAt + MINUTE });
    expect(mergeEntry(entries, again)).toBe(true);
    expect(mergeEntry(entries, unblock)).toBe(false);
    expect(blockedOf(entries)).toEqual(['user-b']);
    const otherOrder: FeedEntries = new Map();
    mergeEntry(otherOrder, unblock);
    mergeEntry(otherOrder, again);
    mergeEntry(otherOrder, block);
    expect(serializeList(otherOrder.values()).hash).toBe(serializeList(entries.values()).hash);
  });
});

describe('dropExpired', () => {
  it('drops entries whose feed time ended and reports whether any left', () => {
    const entries: FeedEntries = new Map();
    mergeEntry(entries, entry({ kind: 'pat', id: 'p', expiresAt: T0 + 15 * MINUTE }));
    mergeEntry(entries, entry({ kind: 'grant', id: 'g', expiresAt: T0 + 20 * MINUTE }));
    expect(dropExpired(entries, T0 + 15 * MINUTE - 1)).toBe(false);
    expect(dropExpired(entries, T0 + 15 * MINUTE)).toBe(true);
    expect([...entries.values()].map(held => held.id)).toEqual(['g']);
  });
});

describe('serializeList', () => {
  it('serves the empty list as valid wire JSON', () => {
    const list = serializeList([]);
    expect(JSON.parse(list.text)).toEqual({
      revoked_before: {},
      revoked_sids: [],
      revoked_kids: [],
      revoked_pat_ids: [],
      blocked_accounts: [],
    });
    expect(list.hash).toBe(createHash('sha256').update(list.text).digest('base64url'));
  });

  it('puts every kind in its field, sorted, without repeats, with revoked_before in whole seconds', () => {
    const list = serializeList([
      entry({ kind: 'subject', id: 'user-b', revokedBefore: T0 + 1999 }),
      entry({ kind: 'subject', id: 'user-a', revokedBefore: T0 + 500 }),
      entry({ kind: 'grant', id: 'g-2' }),
      entry({ kind: 'third_party_family', id: 'f-1' }),
      entry({ kind: 'session', id: 'g-2' }),
      entry({ kind: 'sandbox_grant', id: 's-1' }),
      entry({ kind: 'pat', id: 'pat-1' }),
      entry({ kind: 'bot_key', id: 'bot-1' }),
      entry({ kind: 'kid', id: 'uts-token-03-x' }),
      entry({ kind: 'blocked_account', id: 'user-c' }),
    ]);
    const wire = RevocationListWireSchema.parse(JSON.parse(list.text));
    expect(wire).toEqual({
      revoked_before: { 'user-a': (T0 + 500 - 500) / 1000, 'user-b': (T0 + 1000) / 1000 },
      revoked_sids: ['f-1', 'g-2', 's-1'],
      revoked_kids: ['uts-token-03-x'],
      revoked_pat_ids: ['bot-1', 'pat-1'],
      blocked_accounts: ['user-c'],
    });
  });

  it('gives equal entry sets equal bytes whatever their order, integer-like subjects included', () => {
    const entries = [
      entry({ kind: 'subject', id: '20' }),
      entry({ kind: 'subject', id: 'b' }),
      entry({ kind: 'subject', id: '3' }),
      entry({ kind: 'grant', id: 'z' }),
      entry({ kind: 'grant', id: 'a' }),
    ];
    const forward = serializeList(entries);
    const backward = serializeList([...entries].reverse());
    expect(backward).toEqual(forward);
    expect(forward.text.startsWith('{"revoked_before":{"20":')).toBe(true);
    expect(Object.keys(JSON.parse(forward.text).revoked_before)).toHaveLength(3);
    expect(serializeList(entries.slice(1)).hash).not.toBe(forward.hash);
  });
});
