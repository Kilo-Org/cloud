import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/drizzle';
import { github_install_states, kilocode_users } from '@kilocode/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createInstallState,
  checkInstallState,
  consumeInstallState,
  cleanupExpiredInstallStates,
} from './install-state';

const testUserId = `oauth/install-state-alice-${randomUUID()}`;
const otherUserId = `install-state-bob-${randomUUID()}`;

async function mintState() {
  return createInstallState({
    kiloUserId: testUserId,
    ownerType: 'org',
    ownerId: 'test-organization',
    githubAppType: 'lite',
    returnTo: '/cloud/sessions',
  });
}

async function readState(token: string) {
  const [state] = await db
    .select()
    .from(github_install_states)
    .where(eq(github_install_states.token, token));
  if (!state) throw new Error('Expected test state to exist');
  return state;
}

describe('install-state', () => {
  beforeEach(async () => {
    await db.insert(kilocode_users).values(
      [testUserId, otherUserId].map((id, index) => ({
        id,
        google_user_email: `install-state-${index}-${randomUUID()}@example.com`,
        google_user_name: 'Test Install User',
        google_user_image_url: 'https://example.com/avatar.jpg',
        stripe_customer_id: `cus_test_install_${index}`,
      }))
    );
  });

  afterEach(async () => {
    await db
      .delete(github_install_states)
      .where(inArray(github_install_states.kilo_user_id, [testUserId, otherUserId]));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [testUserId, otherUserId]));
  });

  describe('createInstallState', () => {
    test('stores an opaque token with its initiating user and installation context', async () => {
      const token = await mintState();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const state = await readState(token);
      expect(state).toMatchObject({
        token,
        kilo_user_id: testUserId,
        owner_type: 'org',
        owner_id: 'test-organization',
        github_app_type: 'lite',
        return_to: '/cloud/sessions',
        consumed_at: null,
      });
      expect(new Date(state.expires_at).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(state.expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
    });

    test('stores personal ownership and a null return path', async () => {
      const token = await createInstallState({
        kiloUserId: testUserId,
        ownerType: 'user',
        ownerId: testUserId,
        githubAppType: 'standard',
      });
      expect(await readState(token)).toMatchObject({
        owner_type: 'user',
        owner_id: testUserId,
        return_to: null,
      });
      await expect(checkInstallState(token, otherUserId)).resolves.toEqual({
        status: 'user_mismatch',
        organizationId: null,
        returnTo: null,
      });
    });
  });

  describe('checkInstallState', () => {
    test('checks a matching user without consuming or returning the stored row', async () => {
      const token = await mintState();
      await expect(checkInstallState(token, testUserId)).resolves.toEqual({ status: 'valid' });
      await expect(checkInstallState(token, testUserId)).resolves.toEqual({ status: 'valid' });
      expect((await readState(token)).consumed_at).toBeNull();
    });

    test('reports only recovery context for a different user without mutating state', async () => {
      const token = await mintState();
      const before = await readState(token);
      await expect(checkInstallState(token, otherUserId)).resolves.toEqual({
        status: 'user_mismatch',
        organizationId: 'test-organization',
        returnTo: '/cloud/sessions',
      });
      expect(await readState(token)).toEqual(before);
    });
  });

  describe('consumeInstallState', () => {
    test('consumes a matching arbitrary-string user token exactly once and returns its row', async () => {
      const token = await mintState();
      const first = await consumeInstallState(token, testUserId);
      expect(first.status).toBe('success');
      if (first.status !== 'success') throw new Error('Expected successful consumption');
      expect(first.state).toEqual(await readState(token));
      expect(first.state.consumed_at).not.toBeNull();
      await expect(consumeInstallState(token, testUserId)).resolves.toEqual({ status: 'unusable' });
    });

    test('a foreign callback cannot burn state before the initiator consumes it', async () => {
      const token = await mintState();
      const before = await readState(token);
      await expect(consumeInstallState(token, otherUserId)).resolves.toEqual({
        status: 'user_mismatch',
        organizationId: 'test-organization',
        returnTo: '/cloud/sessions',
      });
      expect(await readState(token)).toEqual(before);
      await expect(consumeInstallState(token, testUserId)).resolves.toMatchObject({
        status: 'success',
        state: { kilo_user_id: testUserId },
      });
      await expect(consumeInstallState(token, testUserId)).resolves.toEqual({ status: 'unusable' });
    });

    test('a session change after valid preflight does not authorize consumption', async () => {
      const token = await mintState();
      await expect(checkInstallState(token, testUserId)).resolves.toEqual({ status: 'valid' });
      await expect(consumeInstallState(token, otherUserId)).resolves.toMatchObject({
        status: 'user_mismatch',
      });
      expect((await readState(token)).consumed_at).toBeNull();
    });

    test.each([true, false])(
      'only the initiator wins concurrent consumption (foreign first: %s)',
      async foreignFirst => {
        const token = await mintState();
        const users = foreignFirst ? [otherUserId, testUserId] : [testUserId, otherUserId];
        const results = await Promise.all(users.map(userId => consumeInstallState(token, userId)));
        expect(results[users.indexOf(testUserId)].status).toBe('success');
        expect(['user_mismatch', 'unusable']).toContain(results[users.indexOf(otherUserId)].status);
        expect(results.filter(result => result.status === 'success')).toHaveLength(1);
        expect((await readState(token)).consumed_at).not.toBeNull();
      }
    );

    test('concurrent matching callbacks consume state exactly once', async () => {
      const token = await mintState();
      const results = await Promise.all([
        consumeInstallState(token, testUserId),
        consumeInstallState(token, testUserId),
      ]);
      expect(results.map(result => result.status).sort()).toEqual(['success', 'unusable']);
    });
  });

  describe('unusable states', () => {
    test.each(['unknown', 'expired', 'consumed'])(
      '%s state is unusable for either user',
      async kind => {
        const token = kind === 'unknown' ? 'nonexistent-test-token' : await mintState();
        if (kind === 'expired') {
          await db
            .update(github_install_states)
            .set({ expires_at: sql`NOW() - INTERVAL '1 second'` })
            .where(eq(github_install_states.token, token));
        }
        if (kind === 'consumed') {
          await consumeInstallState(token, testUserId);
        }
        const before = kind === 'unknown' ? null : await readState(token);
        for (const userId of [testUserId, otherUserId]) {
          await expect(checkInstallState(token, userId)).resolves.toEqual({ status: 'unusable' });
          await expect(consumeInstallState(token, userId)).resolves.toEqual({ status: 'unusable' });
        }
        if (before) expect(await readState(token)).toEqual(before);
      }
    );
  });

  describe('cleanupExpiredInstallStates', () => {
    test('deletes expired rows and retains live rows', async () => {
      const expired = await mintState();
      const live = await mintState();
      await db
        .update(github_install_states)
        .set({ expires_at: sql`NOW() - INTERVAL '1 second'` })
        .where(eq(github_install_states.token, expired));
      expect(await cleanupExpiredInstallStates()).toBeGreaterThanOrEqual(1);
      const remaining = await db
        .select({ token: github_install_states.token })
        .from(github_install_states)
        .where(eq(github_install_states.kilo_user_id, testUserId));
      expect(remaining).toEqual([{ token: live }]);
    });
  });
});
