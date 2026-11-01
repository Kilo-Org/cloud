import { describe, test, expect } from 'vitest';
import { MAX_PROFILE_VARS, setVar } from './profile-vars-service';
import { createLimitTestDb, TEST_PROFILE_ID } from './profile-limit-test-db';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };
const PUBLIC_KEY = '';

function storedKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `VAR_${String(index)}`);
}

describe('setVar limits', () => {
  test('stores a new variable below the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_VARS - 1, storedKeys(MAX_PROFILE_VARS - 1));

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'API_KEY', 'value', false, OWNER)
    ).resolves.toBeUndefined();

    expect(state.upserts).toBe(1);
    expect(state.rowCount).toBe(MAX_PROFILE_VARS);
    expect(state.lockCalls).toBe(1);
  });

  test('rejects a new variable at the cap without writing', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_VARS, storedKeys(MAX_PROFILE_VARS));

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'API_KEY', 'value', false, OWNER)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(state.upserts).toBe(0);
    expect(state.rowCount).toBe(MAX_PROFILE_VARS);
    expect(state.lockCalls).toBe(1);
  });

  test('keeps a stored variable writable at the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_VARS, [
      ...storedKeys(MAX_PROFILE_VARS - 1),
      'API_KEY',
    ]);

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'API_KEY', 'rotated', false, OWNER)
    ).resolves.toBeUndefined();

    expect(state.upserts).toBe(1);
    expect(state.rowCount).toBe(MAX_PROFILE_VARS);
    expect(state.lockCalls).toBe(1);
  });

  test('keeps concurrent new variables within the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_VARS - 1, storedKeys(MAX_PROFILE_VARS - 1));

    const results = await Promise.allSettled([
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'FIRST', 'a', false, OWNER),
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'SECOND', 'b', false, OWNER),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(state.rowCount).toBe(MAX_PROFILE_VARS);
    expect(state.lockCalls).toBe(2);
  });

  test('rejects a new key outside the key contract without writing', async () => {
    const { db, state } = createLimitTestDb(0);

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'api key', 'value', false, OWNER)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(state.upserts).toBe(0);
    expect(state.lockCalls).toBe(1);
  });

  test('rejects a reserved new key without writing', async () => {
    const { db, state } = createLimitTestDb(0);

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'KILO_PROFILE', 'value', false, OWNER)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(state.upserts).toBe(0);
    expect(state.lockCalls).toBe(1);
  });
});
