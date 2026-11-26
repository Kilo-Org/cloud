import { beforeEach, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { kilocode_users, user_sign_in_contexts } from '@kilocode/db/schema';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete-reasons';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  currentSignInContextKey,
  deriveSignInContextKey,
  hashSignInDevice,
  hashSignInKey,
  nativeSignInDevice,
  networkKey,
  networkPrefix,
  pruneSignInContexts,
  recordSignInContext,
  SIGN_IN_CONTEXT_PRUNE_BATCH_SIZE,
  SIGN_IN_CONTEXT_PRUNE_MAX_BATCHES,
  type SignInContextKey,
} from '@/lib/auth/sign-in-context';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const start = new Date('2026-06-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(start.getTime() + offsetMs);

describe('networkPrefix', () => {
  test.each([
    ['203.0.113.45', '203.0.0.0/16'],
    ['::ffff:203.0.113.45', '203.0.0.0/16'],
    ['2001:db8:85a3::8a2e:370:7334', '2001:db8::/32'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::/32'],
    ['2001::1', '2001:0::/32'],
    ['::1', '0:0::/32'],
    ['fe80::1%eth0', 'fe80:0::/32'],
  ])('%s is in %s', (address, prefix) => {
    expect(networkPrefix(address)).toBe(prefix);
  });

  test.each([null, '', 'unknown', '203.0.113', '203.0.113.45:443', '[2001:db8::1]', '999.1.1.1'])(
    '%p has no network',
    address => {
      expect(networkPrefix(address)).toBeNull();
    }
  );
});

describe('networkKey', () => {
  test('joins the platform country with the client prefix', () => {
    const headers = new Headers({
      'x-vercel-forwarded-for': '203.0.113.45, 10.0.0.1',
      'x-vercel-ip-country': 'DE',
    });
    expect(networkKey(headers)).toBe('DE 203.0.0.0/16');
  });

  test('keeps the prefix when the country is missing or malformed', () => {
    expect(networkKey(new Headers({ 'x-real-ip': '2001:db8::1' }))).toBe('unknown 2001:db8::/32');
    expect(
      networkKey(new Headers({ 'x-real-ip': '2001:db8::1', 'x-vercel-ip-country': 'germany' }))
    ).toBe('unknown 2001:db8::/32');
  });

  test('is absent without a usable client address', () => {
    expect(networkKey(new Headers({ 'x-vercel-ip-country': 'DE' }))).toBeNull();
    expect(networkKey(new Headers({ 'x-vercel-forwarded-for': 'not-an-address' }))).toBeNull();
  });
});

describe('sign-in keys', () => {
  const key = currentSignInContextKey();

  test('hash to keyed HMAC-SHA-256 hex, differently per user and kind', () => {
    const one = hashSignInKey(key, 'user-a', 'network', 'DE 203.0.0.0/16');
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSignInKey(key, 'user-b', 'network', 'DE 203.0.0.0/16')).not.toBe(one);
    expect(hashSignInKey(key, 'user-a', 'device', 'DE 203.0.0.0/16')).not.toBe(one);
    // Without the key, the stored digest is not the plain digest of its input.
    expect(one).not.toBe(
      createHash('sha256').update('user-a\u0000network\u0000DE 203.0.0.0/16').digest('hex')
    );
  });

  test('the key comes from the server secret, and its id is a short fingerprint', () => {
    expect(key).toEqual(deriveSignInContextKey(process.env.NEXTAUTH_SECRET ?? ''));
    expect(key.id).toMatch(/^[0-9a-f]{16}$/);
    const rotated = deriveSignInContextKey('another-server-secret');
    expect(rotated.id).not.toBe(key.id);
    expect(hashSignInKey(rotated, 'user-a', 'network', 'DE 203.0.0.0/16')).not.toBe(
      hashSignInKey(key, 'user-a', 'network', 'DE 203.0.0.0/16')
    );
  });

  test('a native device is its iOS attested key, else it has no install key', () => {
    expect(nativeSignInDevice({ platform: 'ios', keyId: 'key-1' })).toEqual({
      kind: 'ios_attested_key',
      keyId: 'key-1',
    });
    expect(nativeSignInDevice({ platform: 'ios' })).toEqual({ kind: 'no_install_key' });
    expect(nativeSignInDevice({ platform: 'android' })).toEqual({ kind: 'no_install_key' });
    expect(hashSignInDevice(key, 'user-a', { kind: 'no_install_key' })).toBeNull();
  });
});

async function signIn(
  userId: string,
  device: string | null,
  network: string | null,
  now: Date,
  key?: SignInContextKey
) {
  return recordSignInContext({
    userId,
    device:
      device === null ? { kind: 'no_install_key' } : { kind: 'browser_cookie', secret: device },
    network,
    now,
    key,
  });
}

async function rows(userId: string) {
  return db
    .select({
      kind: user_sign_in_contexts.kind,
      key_hash: user_sign_in_contexts.key_hash,
      key_id: user_sign_in_contexts.key_id,
      last_seen_at: user_sign_in_contexts.last_seen_at,
    })
    .from(user_sign_in_contexts)
    .where(eq(user_sign_in_contexts.user_id, userId));
}

async function kinds(userId: string) {
  return (await rows(userId)).map(row => row.kind).sort();
}

function laptopHash(userId: string) {
  return hashSignInDevice(currentSignInContextKey(), userId, {
    kind: 'browser_cookie',
    secret: 'laptop',
  });
}

/**
 * Whether a backend of this database waits on a lock `pid` holds before
 * `pending` settles.
 */
async function blockedBy(pid: number, pending: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void pending.finally(() => {
    settled = true;
  });
  while (!settled) {
    const { rows: blocked } = await db.execute(sql`
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
    `);
    if (blocked.length > 0) return true;
  }
  return false;
}

const pidSchema = z.object({ pid: z.number() });

describe('recordSignInContext', () => {
  test('the first sign-in is recorded without a notice, with the history marker', async () => {
    const user = await insertTestUser();

    await expect(signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start)).resolves.toEqual({
      kind: 'bootstrap',
    });
    const recorded = await rows(user.id);
    expect(recorded.map(row => row.kind).sort()).toEqual(['device', 'history', 'network']);
    const keyId = currentSignInContextKey().id;
    expect(recorded.every(row => row.key_id === keyId)).toBe(true);
    expect(recorded.find(row => row.kind === 'history')?.key_hash).toBe(keyId);
  });

  test('a known device on a new network is not new', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    await expect(signIn(user.id, 'laptop', 'FR 198.51.0.0/16', at(2 * HOUR))).resolves.toEqual({
      kind: 'known',
    });
  });

  test('a new device on a known network is not new', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    await expect(signIn(user.id, 'phone', 'DE 203.0.0.0/16', at(2 * HOUR))).resolves.toEqual({
      kind: 'known',
    });
  });

  test('a new device on a new network owns the notice, once per hour', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    await expect(signIn(user.id, 'stranger-1', 'US 192.0.0.0/16', at(HOUR))).resolves.toEqual({
      kind: 'new_device_new_network',
    });

    await expect(
      signIn(user.id, 'stranger-2', 'BR 100.64.0.0/16', at(HOUR + 59 * 60_000))
    ).resolves.toEqual({ kind: 'notice_capped' });

    await expect(
      signIn(user.id, 'stranger-3', 'JP 172.16.0.0/16', at(2 * HOUR + 1))
    ).resolves.toMatchObject({ kind: 'new_device_new_network' });
  });

  test('the cap holds for sign-ins that race', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    const decisions = await Promise.all(
      ['a', 'b', 'c', 'd'].map((device, index) =>
        signIn(user.id, `stranger-${device}`, `US 10.${index}.0.0/16`, at(HOUR))
      )
    );

    expect(decisions.filter(decision => decision.kind === 'new_device_new_network')).toHaveLength(
      1
    );
    expect(decisions.filter(decision => decision.kind === 'notice_capped')).toHaveLength(3);
  });

  test('two first sign-ins that race bootstrap once; the other is decided against it', async () => {
    const user = await insertTestUser();

    const decisions = await Promise.all([
      signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start),
      signIn(user.id, 'stranger', 'US 192.0.0.0/16', start),
    ]);

    expect(decisions.map(decision => decision.kind).sort()).toEqual([
      'bootstrap',
      'new_device_new_network',
    ]);
    expect(await kinds(user.id)).toEqual([
      'device',
      'device',
      'history',
      'network',
      'network',
      'notice',
    ]);
  });

  test('a first sign-in waits for one in flight and is decided against its rows', async () => {
    const user = await insertTestUser();
    const key = currentSignInContextKey();
    const seenAt = start.toISOString();

    // A first sign-in in flight: it holds the user row, as the check does,
    // and has written its bootstrap rows, not yet committed.
    const firstPid = Promise.withResolvers<number>();
    const commitFirst = Promise.withResolvers<void>();
    const first = db.transaction(async tx => {
      const { rows: pidRows } = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`);
      await tx
        .select({ id: kilocode_users.id })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id))
        .for('no key update');
      const row = { user_id: user.id, key_id: key.id, first_seen_at: seenAt, last_seen_at: seenAt };
      await tx.insert(user_sign_in_contexts).values([
        { ...row, kind: 'history', key_hash: key.id },
        { ...row, kind: 'device', key_hash: laptopHash(user.id) ?? '' },
        {
          ...row,
          kind: 'network',
          key_hash: hashSignInKey(key, user.id, 'network', 'DE 203.0.0.0/16'),
        },
      ]);
      firstPid.resolve(pidSchema.parse(pidRows[0]).pid);
      await commitFirst.promise;
    });
    const pid = await firstPid.promise;

    const second = signIn(user.id, 'stranger', 'US 192.0.0.0/16', start);
    const waited = await blockedBy(pid, second);
    commitFirst.resolve();
    await first;

    expect(waited).toBe(true);
    await expect(second).resolves.toEqual({ kind: 'new_device_new_network' });
  });

  test('a request without a client address records the device and decides nothing', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    await expect(signIn(user.id, 'stranger', null, at(HOUR))).resolves.toEqual({
      kind: 'no_network',
    });
    expect((await rows(user.id)).filter(row => row.kind === 'device')).toHaveLength(2);
  });

  test('a first sign-in that records nothing leaves the user new to detection', async () => {
    const user = await insertTestUser();

    await expect(signIn(user.id, null, null, start)).resolves.toEqual({ kind: 'no_network' });
    expect(await rows(user.id)).toEqual([]);
    await expect(signIn(user.id, null, 'DE 203.0.0.0/16', at(HOUR))).resolves.toEqual({
      kind: 'bootstrap',
    });
  });

  test('a capped sign-in records nothing, so its context can notify after the cap', async () => {
    const user = await insertTestUser();
    const key = currentSignInContextKey();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);
    await signIn(user.id, 'stranger-1', 'US 192.0.0.0/16', at(HOUR));

    await expect(
      signIn(user.id, 'stranger-2', 'BR 100.64.0.0/16', at(HOUR + 30 * 60_000))
    ).resolves.toEqual({ kind: 'notice_capped' });
    const stranger2 = hashSignInDevice(key, user.id, {
      kind: 'browser_cookie',
      secret: 'stranger-2',
    });
    const brazil = hashSignInKey(key, user.id, 'network', 'BR 100.64.0.0/16');
    const keys = (await rows(user.id)).map(row => row.key_hash);
    expect(keys).not.toContain(stranger2);
    expect(keys).not.toContain(brazil);

    await expect(
      signIn(user.id, 'stranger-2', 'BR 100.64.0.0/16', at(2 * HOUR + 1))
    ).resolves.toEqual({ kind: 'new_device_new_network' });
  });

  test('an app sign-in without an install key is decided on the network alone', async () => {
    const user = await insertTestUser();
    await expect(signIn(user.id, null, 'DE 203.0.0.0/16', start)).resolves.toEqual({
      kind: 'bootstrap',
    });
    expect(await kinds(user.id)).toEqual(['history', 'network']);

    // The same app (same user agent) on a known network is not new.
    await expect(signIn(user.id, null, 'DE 203.0.0.0/16', at(HOUR))).resolves.toEqual({
      kind: 'known',
    });
    // On a new network it is: the app never counts as a known device.
    await expect(signIn(user.id, null, 'US 192.0.0.0/16', at(2 * HOUR))).resolves.toEqual({
      kind: 'new_device_new_network',
    });
    expect((await rows(user.id)).filter(row => row.kind === 'device')).toHaveLength(0);
  });

  test('a context not seen for 90 days counts as new again, and is refreshed', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);
    await signIn(user.id, 'phone', 'FR 198.51.0.0/16', at(80 * DAY));

    await expect(signIn(user.id, 'laptop', 'US 192.0.0.0/16', at(95 * DAY))).resolves.toEqual({
      kind: 'new_device_new_network',
    });
    const laptop = (await rows(user.id)).find(row => row.key_hash === laptopHash(user.id));
    expect(new Date(laptop?.last_seen_at ?? 0).getTime()).toBe(at(95 * DAY).getTime());
  });

  test('a user with only expired contexts is not new to detection, and is notified', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    await expect(signIn(user.id, 'stranger', 'US 192.0.0.0/16', at(91 * DAY))).resolves.toEqual({
      kind: 'new_device_new_network',
    });
  });

  test('after a key rotation a user is recorded silently again under the new key', async () => {
    const user = await insertTestUser();
    const rotated = deriveSignInContextKey('rotated-server-secret');
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    // Old rows do not match under the new key, and do not count as history.
    await expect(
      signIn(user.id, 'stranger', 'US 192.0.0.0/16', at(HOUR), rotated)
    ).resolves.toEqual({ kind: 'bootstrap' });
    await expect(
      signIn(user.id, 'stranger', 'US 192.0.0.0/16', at(2 * HOUR), rotated)
    ).resolves.toEqual({ kind: 'known' });
    const byKey = Object.groupBy(await rows(user.id), row => row.key_id);
    expect(byKey[rotated.id]?.map(row => row.kind).sort()).toEqual([
      'device',
      'history',
      'network',
    ]);
    expect(byKey[currentSignInContextKey().id]).toHaveLength(3);
  });

  test.each([
    ['soft-deleted', () => createSoftDeletedBlockedReason()],
    ['blocked', () => 'abuse'],
  ])('a check on a %s account writes nothing', async (_label, blockedReason) => {
    const user = await insertTestUser();
    await db
      .update(kilocode_users)
      .set({ blocked_reason: blockedReason() })
      .where(eq(kilocode_users.id, user.id));

    await expect(signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start)).resolves.toEqual({
      kind: 'account_inactive',
    });
    expect(await rows(user.id)).toEqual([]);
  });

  test('a check for a missing user writes nothing', async () => {
    await expect(
      signIn(`missing-${crypto.randomUUID()}`, 'laptop', 'DE 203.0.0.0/16', start)
    ).resolves.toEqual({ kind: 'account_inactive' });
  });

  test('a check overlapping account deletion waits for it, writes nothing, and cannot deadlock', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    // Account deletion's order (anonymizeCloudUserData): lock the user row,
    // later delete the contexts, then mark the row soft-deleted. The context
    // delete must not wait on the check: the lock timeout turns a wait (a
    // deadlock in the making) into a failure.
    const deleterPid = Promise.withResolvers<number>();
    const checkBlocked = Promise.withResolvers<void>();
    const deletion = db.transaction(async tx => {
      const { rows: pidRows } = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`);
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx
        .select({ id: kilocode_users.id })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id))
        .for('update');
      deleterPid.resolve(pidSchema.parse(pidRows[0]).pid);
      await checkBlocked.promise;
      await tx.delete(user_sign_in_contexts).where(eq(user_sign_in_contexts.user_id, user.id));
      await tx
        .update(kilocode_users)
        .set({ blocked_reason: createSoftDeletedBlockedReason() })
        .where(eq(kilocode_users.id, user.id));
    });
    const pid = await deleterPid.promise;

    // A known device on a new network: an unserialized check would hold the
    // laptop row and wait on the user row for the new network row.
    const check = signIn(user.id, 'laptop', 'US 192.0.0.0/16', at(HOUR));
    const waited = await blockedBy(pid, check);
    checkBlocked.resolve();
    expect(waited).toBe(true);

    await expect(deletion).resolves.toBeUndefined();
    await expect(check).resolves.toEqual({ kind: 'account_inactive' });
    expect(await rows(user.id)).toEqual([]);
  });
});

describe('pruneSignInContexts', () => {
  const key = currentSignInContextKey();

  beforeEach(async () => {
    // The prune is table-wide: start each case from an empty table.
    await db.delete(user_sign_in_contexts).where(sql`true`);
  });

  test('deletes contexts past retention and keeps the history marker', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);
    await signIn(user.id, 'stranger', 'US 192.0.0.0/16', at(2 * HOUR));
    await signIn(user.id, 'phone', 'US 192.0.0.0/16', at(80 * DAY));

    await expect(pruneSignInContexts({ now: at(91 * DAY), key })).resolves.toEqual({
      expiredDeleted: 4,
      otherKeyDeleted: 0,
      hasMore: false,
    });
    // Left: the history marker and the contexts seen on day 80.
    expect(await kinds(user.id)).toEqual(['device', 'history', 'network']);
  });

  test('expiry does not make a user new to detection again', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    await pruneSignInContexts({ now: at(91 * DAY), key });
    expect(await kinds(user.id)).toEqual(['history']);

    await expect(signIn(user.id, 'stranger', 'US 192.0.0.0/16', at(92 * DAY))).resolves.toEqual({
      kind: 'new_device_new_network',
    });
  });

  test('deletes every row under another key', async () => {
    const user = await insertTestUser();
    const rotated = deriveSignInContextKey('rotated-server-secret');
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', at(HOUR), rotated);

    await expect(pruneSignInContexts({ now: at(2 * HOUR), key: rotated })).resolves.toEqual({
      expiredDeleted: 0,
      otherKeyDeleted: 3,
      hasMore: false,
    });
    expect((await rows(user.id)).every(row => row.key_id === rotated.id)).toBe(true);
    expect(await kinds(user.id)).toEqual(['device', 'history', 'network']);
  });

  test('stops at the batch limit and reports hasMore', async () => {
    const user = await insertTestUser();
    const limit = SIGN_IN_CONTEXT_PRUNE_BATCH_SIZE * SIGN_IN_CONTEXT_PRUNE_MAX_BATCHES;
    await db.execute(sql`
      INSERT INTO user_sign_in_contexts (user_id, kind, key_hash, key_id, first_seen_at, last_seen_at)
      SELECT ${user.id}, 'network', 'hash-' || n, ${key.id}, ${start.toISOString()}::timestamptz,
        ${start.toISOString()}::timestamptz
      FROM generate_series(1, ${limit + 1}) AS n
    `);

    await expect(pruneSignInContexts({ now: at(91 * DAY), key })).resolves.toEqual({
      expiredDeleted: limit,
      otherKeyDeleted: 0,
      hasMore: true,
    });
    await expect(pruneSignInContexts({ now: at(91 * DAY), key })).resolves.toEqual({
      expiredDeleted: 1,
      otherKeyDeleted: 0,
      hasMore: false,
    });
    expect(await rows(user.id)).toEqual([]);
  }, 60_000);

  test('skips a row a sign-in holds, instead of waiting on it', async () => {
    const user = await insertTestUser();
    const laptop = laptopHash(user.id);
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    const holderPid = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const holder = db.transaction(async tx => {
      const { rows: pidRows } = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`);
      await tx
        .select({ kind: user_sign_in_contexts.kind })
        .from(user_sign_in_contexts)
        .where(
          and(
            eq(user_sign_in_contexts.user_id, user.id),
            eq(user_sign_in_contexts.kind, 'device'),
            eq(user_sign_in_contexts.key_hash, laptop ?? '')
          )
        )
        .for('update');
      holderPid.resolve(pidSchema.parse(pidRows[0]).pid);
      await release.promise;
    });
    const pid = await holderPid.promise;

    const pending = pruneSignInContexts({ now: at(91 * DAY), key });
    const waitedOnHolder = await blockedBy(pid, pending);
    release.resolve();
    await holder;

    expect(waitedOnHolder).toBe(false);
    await expect(pending).resolves.toMatchObject({ expiredDeleted: 1 });
    expect((await rows(user.id)).map(row => row.key_hash)).toContain(laptop);
  });
});
