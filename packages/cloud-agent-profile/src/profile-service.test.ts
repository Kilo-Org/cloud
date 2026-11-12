import { describe, expect, test } from 'vitest';
import type { WorkerDb } from '@kilocode/db';
import { MAX_OWNER_PROFILES } from './contracts/profiles';
import { createProfile } from './profile-service';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };

/**
 * In-memory stand-in for the pool-backed `WorkerDb`.
 *
 * Transactions are serialized, the way the owner-scoped advisory lock
 * serializes them in PostgreSQL. `events` records the statements in order.
 */
function createProfileTestDb(initialProfileCount: number) {
  let profileCount = initialProfileCount;
  const events: string[] = [];

  const select = () => ({
    from: () => ({
      where: () => {
        events.push('count');
        return Promise.resolve([{ n: profileCount }]);
      },
    }),
  });

  const insert = () => ({
    values: () => ({
      returning: () => {
        events.push('insert');
        profileCount += 1;
        return Promise.resolve([{ id: `profile-${profileCount}` }]);
      },
    }),
  });

  const execute = () => {
    events.push('lock');
    return Promise.resolve();
  };

  const channel = { select, insert, execute };
  let tail: Promise<unknown> = Promise.resolve();

  const db = {
    $client: {},
    select,
    insert,
    execute,
    transaction: <T>(work: (tx: typeof channel) => Promise<T>): Promise<T> => {
      const run = tail.then(() => work(channel));
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };

  return { db: db as unknown as WorkerDb, events, storedCount: () => profileCount };
}

describe('createProfile owner cap', () => {
  test('creates a profile and takes the owner lock before counting', async () => {
    const { db, events, storedCount } = createProfileTestDb(MAX_OWNER_PROFILES - 1);

    await expect(createProfile(db, OWNER, OWNER.id, 'Deploy')).resolves.toEqual({
      id: expect.any(String),
    });
    expect(storedCount()).toBe(MAX_OWNER_PROFILES);
    expect(events).toEqual(['lock', 'count', 'insert']);
  });

  test('refuses a create at the owner cap', async () => {
    const { db, storedCount } = createProfileTestDb(MAX_OWNER_PROFILES);

    await expect(createProfile(db, OWNER, OWNER.id, 'Deploy')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_OWNER_PROFILES} per account`,
    });
    expect(storedCount()).toBe(MAX_OWNER_PROFILES);
  });

  test('permits one of two simultaneous creates at the owner cap', async () => {
    const { db, storedCount } = createProfileTestDb(MAX_OWNER_PROFILES - 1);

    const results = await Promise.allSettled([
      createProfile(db, OWNER, OWNER.id, 'First'),
      createProfile(db, OWNER, OWNER.id, 'Second'),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: 'PRECONDITION_FAILED' } });
    expect(storedCount()).toBe(MAX_OWNER_PROFILES);
  });
});
