import { describe, expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { user_sign_in_contexts } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  hashSignInDevice,
  hashSignInKey,
  nativeSignInDevice,
  networkKey,
  networkPrefix,
  recordSignInContext,
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
  test('hash to SHA-256 hex, differently per user', () => {
    const one = hashSignInKey('user-a', 'network', 'DE 203.0.0.0/16');
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSignInKey('user-b', 'network', 'DE 203.0.0.0/16')).not.toBe(one);
    expect(hashSignInKey('user-a', 'device', 'DE 203.0.0.0/16')).not.toBe(one);
  });

  test('a native device is its iOS attested key, else its user agent', () => {
    expect(
      nativeSignInDevice({ platform: 'ios', keyId: 'key-1' }, 'Kilo-Code/1.0.4 (ios)')
    ).toEqual({ kind: 'ios_attested_key', keyId: 'key-1' });
    expect(nativeSignInDevice({ platform: 'android' }, 'Kilo-Code/1.0.4 (android)')).toEqual({
      kind: 'user_agent',
      userAgent: 'Kilo-Code/1.0.4 (android)',
    });
  });
});

describe('recordSignInContext', () => {
  async function signIn(userId: string, device: string, network: string | null, now: Date) {
    return recordSignInContext({
      userId,
      deviceKeyHash: hashSignInDevice(userId, { kind: 'browser_cookie', secret: device }),
      networkKeyHash: network === null ? null : hashSignInKey(userId, 'network', network),
      now,
    });
  }

  async function rows(userId: string) {
    return db
      .select({
        kind: user_sign_in_contexts.kind,
        key_hash: user_sign_in_contexts.key_hash,
        last_seen_at: user_sign_in_contexts.last_seen_at,
      })
      .from(user_sign_in_contexts)
      .where(eq(user_sign_in_contexts.user_id, userId));
  }

  test('the first sign-in is recorded without a notice', async () => {
    const user = await insertTestUser();

    await expect(signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start)).resolves.toEqual({
      kind: 'bootstrap',
    });
    expect((await rows(user.id)).map(row => row.kind).sort()).toEqual(['device', 'network']);
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

    const first = await signIn(user.id, 'stranger-1', 'US 192.0.0.0/16', at(HOUR));
    expect(first).toEqual({
      kind: 'new_device_new_network',
      deviceKeyHash: hashSignInDevice(user.id, { kind: 'browser_cookie', secret: 'stranger-1' }),
      networkKeyHash: hashSignInKey(user.id, 'network', 'US 192.0.0.0/16'),
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

  test('a request without a client address records the device and decides nothing', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    await expect(signIn(user.id, 'stranger', null, at(HOUR))).resolves.toEqual({
      kind: 'no_network',
    });
    expect((await rows(user.id)).filter(row => row.kind === 'device')).toHaveLength(2);
  });

  test('a context not seen for 90 days is deleted, and counts as new again', async () => {
    const user = await insertTestUser();
    const laptop = hashSignInDevice(user.id, { kind: 'browser_cookie', secret: 'laptop' });
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);
    await signIn(user.id, 'phone', 'DE 203.0.0.0/16', at(80 * DAY));

    // The laptop was last seen 95 days ago: this sign-in deletes its row.
    await signIn(user.id, 'tablet', 'DE 203.0.0.0/16', at(95 * DAY));
    expect((await rows(user.id)).map(row => row.key_hash)).not.toContain(laptop);
    expect((await rows(user.id)).filter(row => row.kind === 'device')).toHaveLength(2);

    await expect(signIn(user.id, 'laptop', 'US 192.0.0.0/16', at(96 * DAY))).resolves.toEqual({
      kind: 'new_device_new_network',
      deviceKeyHash: laptop,
      networkKeyHash: hashSignInKey(user.id, 'network', 'US 192.0.0.0/16'),
    });
  });

  test('an expired context that signs in again is new, and is kept', async () => {
    const user = await insertTestUser();
    const laptop = hashSignInDevice(user.id, { kind: 'browser_cookie', secret: 'laptop' });
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);
    await signIn(user.id, 'phone', 'FR 198.51.0.0/16', at(80 * DAY));

    await expect(signIn(user.id, 'laptop', 'US 192.0.0.0/16', at(95 * DAY))).resolves.toMatchObject(
      { kind: 'new_device_new_network', deviceKeyHash: laptop }
    );
    // The expired network row is deleted; the laptop row is refreshed, not deleted.
    expect((await rows(user.id)).map(row => row.kind).sort()).toEqual([
      'device',
      'device',
      'network',
      'network',
      'notice',
    ]);
    expect((await rows(user.id)).map(row => row.key_hash)).toContain(laptop);
  });

  test('a user with only expired contexts starts over without a notice', async () => {
    const user = await insertTestUser();
    await signIn(user.id, 'laptop', 'DE 203.0.0.0/16', start);

    await expect(signIn(user.id, 'stranger', 'US 192.0.0.0/16', at(91 * DAY))).resolves.toEqual({
      kind: 'bootstrap',
    });
    expect(await rows(user.id)).toHaveLength(2);
  });
});
