/**
 * Integration tests for the owner-level profile cap against the real web
 * Postgres harness: the advisory-lock serialization cannot be faked.
 */
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { db, pool } from '@kilocode/web-shared/lib/drizzle';
import { agent_environment_profiles } from '@kilocode/db/schema';
import { count, eq } from 'drizzle-orm';
import { MAX_OWNER_PROFILES, profileOwnerLockKey } from '@kilocode/cloud-agent-profile';
import type { User } from '@kilocode/db/schema';
import { rollbackQuietly, waitForBlockedLockWaiters } from './blocked-lock-waiters';

describe('owner profile cap', () => {
  let owner: User;

  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'agent-profiles-owner-cap@example.com',
      google_user_name: 'Agent Profiles Owner Cap',
    });
  });

  afterEach(async () => {
    await db
      .delete(agent_environment_profiles)
      .where(eq(agent_environment_profiles.owned_by_user_id, owner.id));
  });

  test('permits one of two simultaneous creates at the owner cap', async () => {
    const caller = await createCallerForUser(owner.id);
    await db.insert(agent_environment_profiles).values(
      Array.from({ length: MAX_OWNER_PROFILES - 1 }, (_, index) => ({
        owned_by_user_id: owner.id,
        name: `Existing ${String(index)}`,
      }))
    );

    // Hold the owner's advisory lock from another connection so both creates
    // wait on it. Observing two waiters proves both creates reach the owner
    // lock.
    const lockClient = await pool.connect();
    try {
      await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        profileOwnerLockKey({ type: 'user', id: owner.id }),
      ]);

      const both = Promise.allSettled([
        caller.agentProfiles.create({ name: 'Concurrent A' }),
        caller.agentProfiles.create({ name: 'Concurrent B' }),
      ]);
      await waitForBlockedLockWaiters(lockClient, 2);
      await lockClient.query('SELECT pg_advisory_unlock_all()');
      const results = await both;

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter(result => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ reason: { code: 'PRECONDITION_FAILED' } });

      const [row] = await db
        .select({ n: count() })
        .from(agent_environment_profiles)
        .where(eq(agent_environment_profiles.owned_by_user_id, owner.id));
      expect(Number(row.n)).toBe(MAX_OWNER_PROFILES);

      // Freeing one slot lets the owner create again.
      const [stored] = await db
        .select({ id: agent_environment_profiles.id })
        .from(agent_environment_profiles)
        .where(eq(agent_environment_profiles.owned_by_user_id, owner.id))
        .limit(1);
      await caller.agentProfiles.delete({ profileId: stored.id });
      await expect(caller.agentProfiles.create({ name: 'After delete' })).resolves.toEqual({
        id: expect.any(String),
      });
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock_all()');
      await rollbackQuietly(lockClient);
      lockClient.release();
    }
  }, 30000);
});
