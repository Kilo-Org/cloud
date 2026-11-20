import { describe, expect, test } from 'vitest';
import type { WorkerDb } from '@kilocode/db';
import { applyDefaultProfile } from './profile-service';
import { createLimitTestDb } from './profile-limit-test-db';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };

/**
 * The flip takes the caller's open transaction, so every case runs it the way a
 * production caller does: the clear and the set-true share one unit.
 */
async function applyDefaultInTransaction(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner
): Promise<void> {
  await db.transaction(async tx => {
    await applyDefaultProfile(tx, profileId, owner);
  });
}

describe('applyDefaultProfile', () => {
  test('moves the default to the profile the owner holds', async () => {
    const { db, state } = createLimitTestDb(
      2,
      [],
      [
        { id: 'profile-current', ownerType: 'user', ownerId: 'user_test', isDefault: true },
        { id: 'profile-next', ownerType: 'user', ownerId: 'user_test', isDefault: false },
      ]
    );

    await applyDefaultInTransaction(db, 'profile-next', OWNER);

    const defaultIds = state.profileRows.filter(row => row.isDefault).map(row => row.id);
    expect(defaultIds).toEqual(['profile-next']);

    // Both statements name the owner as well as the profile, so the pair moves
    // the flag only between rows this owner holds.
    const setTrue = state.defaultWrites.filter(write => write.isDefault);
    expect(setTrue).toHaveLength(1);
    expect(setTrue[0].conditionColumns).toEqual(expect.arrayContaining(['id', 'owned_by_user_id']));
    expect(setTrue[0].matchedProfileIds).toEqual(['profile-next']);

    const clear = state.defaultWrites.filter(write => !write.isDefault);
    expect(clear).toHaveLength(1);
    expect(clear[0].conditionColumns).toEqual(
      expect.arrayContaining(['owned_by_user_id', 'is_default'])
    );
    expect(clear[0].matchedProfileIds).toEqual(['profile-current']);
  });

  test('never flips a profile the owner does not hold', async () => {
    const { db, state } = createLimitTestDb(
      2,
      [],
      [
        { id: 'profile-current', ownerType: 'user', ownerId: 'user_test', isDefault: true },
        { id: 'profile-foreign', ownerType: 'user', ownerId: 'other_user', isDefault: false },
      ]
    );

    // An id-only set-true claimed the foreign row: the other owner silently
    // gained this owner's default flag, which the one-default-per-owner index
    // then reports as a unique violation on the next write. The set-true
    // update asserts one affected row, so this call fails loudly instead.
    await expect(applyDefaultInTransaction(db, 'profile-foreign', OWNER)).rejects.toThrow(
      /no profile/i
    );

    const setTrue = state.defaultWrites.filter(write => write.isDefault);
    expect(setTrue).toHaveLength(1);
    expect(setTrue[0].matchedProfileIds).toEqual([]);
    expect(state.profileRows.some(row => row.isDefault)).toBe(false);
  });

  test('resolves when the set-true update reaches exactly one profile', async () => {
    const { db, state } = createLimitTestDb(
      1,
      [],
      [{ id: 'profile-solo', ownerType: 'user', ownerId: 'user_test', isDefault: false }]
    );

    await expect(applyDefaultInTransaction(db, 'profile-solo', OWNER)).resolves.toBeUndefined();

    const setTrue = state.defaultWrites.filter(write => write.isDefault);
    expect(setTrue).toHaveLength(1);
    expect(setTrue[0].matchedProfileIds).toEqual(['profile-solo']);
    expect(state.profileRows.find(row => row.id === 'profile-solo')?.isDefault).toBe(true);
  });

  test('scopes an organization owner to the organization column', async () => {
    const organization: ProfileOwner = { type: 'organization', id: 'org_test' };
    const { db, state } = createLimitTestDb(
      1,
      [],
      [
        { id: 'org-profile', ownerType: 'organization', ownerId: 'org_test', isDefault: false },
        { id: 'user-profile', ownerType: 'user', ownerId: 'user_test', isDefault: false },
      ]
    );

    await applyDefaultInTransaction(db, 'org-profile', organization);

    const setTrue = state.defaultWrites.filter(write => write.isDefault);
    expect(setTrue).toHaveLength(1);
    const organizationColumns = ['id', 'owned_by_organization_id'];
    expect(setTrue[0].conditionColumns).toEqual(expect.arrayContaining(organizationColumns));
    expect(setTrue[0].matchedProfileIds).toEqual(['org-profile']);

    // The user-owned row carries no organization id, so the owner predicate
    // excludes it even though the update names no user column.
    expect(state.profileRows.find(row => row.id === 'user-profile')?.isDefault).toBe(false);
  });
});
