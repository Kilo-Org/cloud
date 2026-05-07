import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signKiloToken } from '@kilocode/worker-utils';

import type * as do_module from '../dos/NotificationChannelDO';

type DOStub = DurableObjectStub<do_module.NotificationChannelDO>;

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

function getDO(name: string): DOStub {
  const id = env.NOTIFICATION_CHANNEL_DO.idFromName(name);
  return env.NOTIFICATION_CHANNEL_DO.get(id);
}

async function seedBuckets(stub: DOStub, buckets: Record<string, number>) {
  await runInDurableObject(stub, async (_inst, state) => {
    for (const [bucket, count] of Object.entries(buckets)) {
      await state.storage.put<number>(`bucket:${bucket}`, count);
    }
  });
}

async function tokenFor(userId: string): Promise<string> {
  const { token } = await signKiloToken({
    userId,
    pepper: null,
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
    env: env.WORKER_ENV,
    extra: { tokenSource: 'kilo-chat' },
  });
  return token;
}

describe('badge HTTP routes', () => {
  beforeEach(() => {
    // The auth middleware reads NEXTAUTH_SECRET via getCachedSecret. The
    // test JWT secret has to round-trip through the SecretsStore binding.
    vi.spyOn(env.NEXTAUTH_SECRET, 'get').mockResolvedValue(TEST_JWT_SECRET);
  });

  describe('GET /v1/badges', () => {
    it('returns 401 without a bearer token', async () => {
      const res = await SELF.fetch('https://example.com/v1/badges');
      expect(res.status).toBe(401);
    });

    it('returns the user buckets for a valid JWT', async () => {
      const userId = 'user-routes-list';
      await seedBuckets(getDO(userId), {
        'kiloclaw:sb1:c1': 2,
        'kiloclaw:sb1:c2': 1,
      });

      const token = await tokenFor(userId);
      const res = await SELF.fetch('https://example.com/v1/badges', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{
        buckets: { badgeBucket: string; badgeCount: number }[];
      }>();
      body.buckets.sort((a, b) => a.badgeBucket.localeCompare(b.badgeBucket));
      expect(body).toEqual({
        buckets: [
          { badgeBucket: 'kiloclaw:sb1:c1', badgeCount: 2 },
          { badgeBucket: 'kiloclaw:sb1:c2', badgeCount: 1 },
        ],
      });
    });

    it('isolates buckets per caller - JWT for userA never sees userB state', async () => {
      const userA = 'user-routes-a';
      const userB = 'user-routes-b';
      await seedBuckets(getDO(userB), { 'kiloclaw:sb:c': 7 });

      const tokenA = await tokenFor(userA);
      const res = await SELF.fetch('https://example.com/v1/badges', {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ buckets: unknown[] }>();
      expect(body.buckets).toEqual([]);
    });
  });

  describe('POST /v1/badges/mark-read', () => {
    it('returns 401 without a bearer token', async () => {
      const res = await SELF.fetch('https://example.com/v1/badges/mark-read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ badgeBucket: 'conv1' }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 when badgeBucket is missing', async () => {
      const userId = 'user-routes-mark-bad';
      const token = await tokenFor(userId);
      const res = await SELF.fetch('https://example.com/v1/badges/mark-read', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'badgeBucket required' });
    });

    it('returns 400 when badgeBucket is not a string', async () => {
      const userId = 'user-routes-mark-invalid';
      const token = await tokenFor(userId);
      const res = await SELF.fetch('https://example.com/v1/badges/mark-read', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ badgeBucket: 123 }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'badgeBucket required' });
    });

    it('clears the bucket and returns the new total', async () => {
      const userId = 'user-routes-mark';
      await seedBuckets(getDO(userId), { conv1: 2, conv2: 5 });

      const token = await tokenFor(userId);
      const res = await SELF.fetch('https://example.com/v1/badges/mark-read', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ badgeBucket: 'conv1' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ badgeCount: 5 });

      // Confirm storage matches.
      const remaining = await runInDurableObject(getDO(userId), async (_inst, state) => {
        const entries = await state.storage.list<number>({ prefix: 'bucket:' });
        return Array.from(entries.entries());
      });
      expect(remaining).toEqual([['bucket:conv2', 5]]);
    });
  });

  describe('clearBadgeBucketForUser RPC', () => {
    it('clears the requested user bucket and returns the new total', async () => {
      const userId = 'user-rpc-mark';
      await seedBuckets(getDO(userId), { conv1: 2, conv2: 5 });

      await expect(
        env.SELF.clearBadgeBucketForUser({ userId, badgeBucket: 'conv1' })
      ).resolves.toEqual({ badgeCount: 5 });

      const remaining = await getDO(userId).listNonZeroBuckets();
      expect(remaining).toEqual([{ badgeBucket: 'conv2', badgeCount: 5 }]);
    });
  });
});
