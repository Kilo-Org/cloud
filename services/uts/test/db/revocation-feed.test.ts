import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityStore } from '../../src/db/client';
import { FEED_MAX_ENTRIES } from '../../src/revocation/entries';
import { readFeedEntries } from '../../src/revocation/store';
import { TestDatabase, sqlStateOf } from './harness';

/**
 * The feed objects' backfill reads (`src/revocation/store.ts`) as the app login, and the entry
 * kinds migration 0006 adds, against the migrated schema.
 */

let db: TestDatabase;
let owner: pg.Client;
let store: IdentityStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  store = new IdentityStore(await db.connect('uts_app_a'));
});
afterAll(() => db.drop());

const MINUTE = 60_000;

async function insertEntry(
  kind: string,
  id: string,
  revokedAgo: string,
  keptFor: string,
  revokedBeforeAgo: string | null = null
): Promise<void> {
  await owner.query(
    `INSERT INTO uts.revocations (kind, subject_id, revoked_before, revoked_at, feed_expires_at)
     VALUES ($1, $2, now() - $5::interval, now() - $3::interval, now() - $3::interval + $4::interval)`,
    [kind, id, revokedAgo, keptFor, revokedBeforeAgo]
  );
}

describe('backfill reads', () => {
  const ids = {
    subject: randomUUID(),
    pat: randomUUID(),
    old: randomUUID(),
    expired: randomUUID(),
    blocked: randomUUID(),
  };

  beforeAll(async () => {
    await insertEntry('subject', ids.subject, '1 minute', '70 minutes', '2 minutes');
    await insertEntry('pat', ids.pat, '2 minutes', '15 minutes');
    await insertEntry('blocked_account', ids.blocked, '3 minutes', '15 minutes');
    // Revoked 30 minutes ago and still in the feed: only a full read brings it.
    await insertEntry('grant', ids.old, '30 minutes', '40 minutes');
    await insertEntry('grant', ids.expired, '25 minutes', '20 minutes');
  });

  it('reads the entries revoked in the window, still in the feed, in epoch milliseconds', async () => {
    const before = Date.now();
    const result = await readFeedEntries(store, {
      kind: 'recent',
      since: new Date(before - 20 * MINUTE),
    });
    if (result.status !== 'read') throw new Error(result.status);
    const byId = new Map(result.entries.map(entry => [entry.id, entry]));
    expect([...byId.keys()].sort()).toEqual([ids.blocked, ids.pat, ids.subject].sort());
    const subject = byId.get(ids.subject);
    expect(subject?.kind).toBe('subject');
    expect(subject?.revokedBefore).toBeGreaterThan(before - 3 * MINUTE);
    expect(subject?.revokedBefore).toBeLessThan(subject?.revokedAt ?? 0);
    expect(byId.get(ids.pat)).toMatchObject({ kind: 'pat', revokedBefore: null });
    const pat = byId.get(ids.pat);
    expect((pat?.expiresAt ?? 0) - (pat?.revokedAt ?? 0)).toBe(15 * MINUTE);
    expect(byId.get(ids.blocked)).toMatchObject({ kind: 'blocked_account' });
  });

  it('reads every entry still in the feed for a full read, and none that left it', async () => {
    const result = await readFeedEntries(store, { kind: 'all' });
    if (result.status !== 'read') throw new Error(result.status);
    const found = result.entries.map(entry => entry.id);
    expect(found).toEqual(expect.arrayContaining([ids.subject, ids.pat, ids.blocked, ids.old]));
    expect(found).not.toContain(ids.expired);
  });

  it('refuses a PAT entry kept other than 15 minutes, as the table always has', async () => {
    expect(
      await sqlStateOf(() => insertEntry('pat', randomUUID(), '0 minutes', '20 minutes'))
    ).toBe('23514');
  });
});

describe('a feed past its size limit', () => {
  it('reads as too many, so a feed object signs no partial list', async () => {
    const crowded = await TestDatabase.create();
    try {
      const crowdedOwner = await crowded.connectAsOwner();
      await crowdedOwner.query(
        `INSERT INTO uts.revocations (kind, subject_id, feed_expires_at)
         SELECT 'grant', 'g-' || n, now() + interval '20 minutes'
         FROM generate_series(1, $1::int) AS n`,
        [FEED_MAX_ENTRIES + 1]
      );
      const crowdedStore = new IdentityStore(await crowded.connect('uts_app_a'));
      expect(await readFeedEntries(crowdedStore, { kind: 'all' })).toEqual({
        status: 'too_many',
        limit: FEED_MAX_ENTRIES,
      });
      expect(
        await readFeedEntries(crowdedStore, {
          kind: 'recent',
          since: new Date(Date.now() - 20 * MINUTE),
        })
      ).toEqual({ status: 'too_many', limit: FEED_MAX_ENTRIES });
    } finally {
      await crowded.drop();
    }
  });
});
