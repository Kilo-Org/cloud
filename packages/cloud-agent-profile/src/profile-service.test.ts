import { describe, expect, test } from 'vitest';
import { applyDefaultProfile } from './profile-service';
import { createLimitTestDb } from './profile-limit-test-db';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };

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

    await applyDefaultProfile(db, 'profile-next', OWNER);

    const defaultIds = state.profileRows.filter(row => row.isDefault).map(row => row.id);
    expect(defaultIds).toEqual(['profile-next']);

    // Both statements must name the owner as well as the profile: a set-true
    // that matches on the id alone can claim a row the caller does not own.
    const setTrue = state.defaultWrites.filter(write => write.isDefault);
    expect(setTrue).toHaveLength(1);
    expect(setTrue[0].conditionColumns).toEqual(expect.arrayContaining(['id', 'owned_by_user_id']));
    expect(setTrue[0].matchedProfileIds).toEqual(['profile-next']);
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

    await applyDefaultProfile(db, 'profile-foreign', OWNER);

    // An id-only set-true claimed the foreign row: the other owner silently
    // gained this owner's default flag, which the one-default-per-owner index
    // then reports as a unique violation on the next write.
    const setTrue = state.defaultWrites.filter(write => write.isDefault);
    expect(setTrue).toHaveLength(1);
    expect(setTrue[0].matchedProfileIds).toEqual([]);
    expect(state.profileRows.some(row => row.isDefault)).toBe(false);
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

    await applyDefaultProfile(db, 'org-profile', organization);

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
