import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  kilocode_users,
  organization_membership_removals,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// Stripe is not reachable in tests (`.env.test` sets a deliberately invalid
// key), so the two entry points that provision a customer are stubbed. Both are
// exercised for real in production; what matters here is the directory-sync
// logic around them. `jest.mock('@/lib/organizations/organization-billing')`
// mirrors `src/routers/organizations/organization-creation.test.ts:19`.
jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn().mockResolvedValue('cus_test_scim_org'),
}));

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn().mockResolvedValue({ id: 'cus_test_scim_user' }),
  deleteStripeCustomer: jest.fn().mockResolvedValue(undefined),
}));

import {
  addDirectoryMembership,
  deleteDirectoryOrganization,
  deleteDirectorySubOrganization,
  DirectorySyncConflictError,
  removeDirectoryMembership,
  upsertDirectoryOrganization,
  upsertDirectorySubOrganization,
  upsertDirectoryUser,
} from './directory-sync';

// WorkOS identifiers, shaped like the real ones from a directory-sync payload.
let suffix: string;
let directoryId: string;
let directoryGroupId: string;
let directoryIdpId: string;
let workOSOrganizationId: string;
let externalId: string;
let email: string;

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

function trackOrganization(id: string): string {
  createdOrganizationIds.push(id);
  return id;
}

beforeEach(() => {
  suffix = randomUUID();
  directoryId = `directory_${suffix}`;
  directoryGroupId = `directory_group_${suffix}`;
  directoryIdpId = `idp_group_${suffix}`;
  workOSOrganizationId = `org_${suffix}`;
  externalId = `directory_user_${suffix}`;
  email = `scim-${suffix}@example.test`;
});

afterEach(async () => {
  if (createdOrganizationIds.length > 0) {
    await db
      .delete(organization_membership_removals)
      .where(inArray(organization_membership_removals.organization_id, createdOrganizationIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, createdOrganizationIds));
    // Children first: the self-referential foreign key is ON DELETE RESTRICT.
    await db
      .delete(organizations)
      .where(inArray(organizations.parent_organization_id, createdOrganizationIds));
    await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
    createdOrganizationIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

async function seedOrganization(): Promise<string> {
  const result = await upsertDirectoryOrganization(directoryId, {
    workOSOrganizationId,
    name: `SCIM Org ${suffix}`,
  });
  return trackOrganization(result.id);
}

async function seedSubOrganization(): Promise<string> {
  const result = await upsertDirectorySubOrganization(directoryGroupId, {
    directoryId,
    directoryIdpId,
    name: `kilo-users-${suffix}`,
  });
  return trackOrganization(result.id);
}

async function seedUser(): Promise<string> {
  const result = await upsertDirectoryUser(externalId, {
    email,
    firstName: 'Bob',
    lastName: 'Bobert',
    idpId: `idp_${suffix}`,
  });
  createdUserIds.push(result.id);
  return result.id;
}

describe('upsertDirectoryOrganization', () => {
  test('creates an organization bound to the directory and the WorkOS organization', async () => {
    const organizationId = await seedOrganization();

    const [row] = await db.select().from(organizations).where(eq(organizations.id, organizationId));

    expect(row.directory_id).toBe(directoryId);
    expect(row.external_org_id).toBe(workOSOrganizationId);
    expect(row.parent_organization_id).toBeNull();
  });

  test('is idempotent: a replayed event returns the same organization', async () => {
    const first = await seedOrganization();
    const second = await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `SCIM Org ${suffix}`,
    });

    expect(second.id).toBe(first);
    expect(second.created).toBe(false);
  });

  test('adopts an existing organization that already carries the WorkOS id', async () => {
    // A customer-created organization is adopted rather than duplicated.
    const adopted = await upsertDirectoryOrganization(`directory_other_${suffix}`, {
      workOSOrganizationId,
      name: `Pre-existing ${suffix}`,
    });
    trackOrganization(adopted.id);

    const bound = await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `Ignored ${suffix}`,
    });

    expect(bound.id).toBe(adopted.id);
    expect(bound.created).toBe(false);
  });
});

describe('upsertDirectorySubOrganization', () => {
  test('creates a sub-organization under the directory owner', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();

    const [child] = await db.select().from(organizations).where(eq(organizations.id, childId));

    expect(child.parent_organization_id).toBe(parentId);
    expect(child.directory_group_id).toBe(directoryGroupId);
    expect(child.directory_idp_id).toBe(directoryIdpId);
  });

  test('is idempotent and applies a rename on repeat', async () => {
    await seedOrganization();
    const first = await seedSubOrganization();

    const renamed = await upsertDirectorySubOrganization(directoryGroupId, {
      directoryId,
      directoryIdpId,
      name: `kilo-admins-${suffix}`,
    });

    expect(renamed.id).toBe(first);
    expect(renamed.created).toBe(false);

    const [child] = await db.select().from(organizations).where(eq(organizations.id, first));
    expect(child.name).toBe(`kilo-admins-${suffix}`);
  });

  test('rejects a group whose directory has no organization', async () => {
    await expect(
      upsertDirectorySubOrganization(directoryGroupId, {
        directoryId: `directory_absent_${suffix}`,
        directoryIdpId,
        name: `orphan-${suffix}`,
      })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('refuses to nest a group under a sub-organization', async () => {
    // The hierarchy is one level deep.
    await seedOrganization();
    const childId = await seedSubOrganization();
    await db
      .update(organizations)
      .set({ directory_id: `directory_nested_${suffix}` })
      .where(eq(organizations.id, childId));

    await expect(
      upsertDirectorySubOrganization(`directory_group_nested_${suffix}`, {
        directoryId: `directory_nested_${suffix}`,
        directoryIdpId: `idp_nested_${suffix}`,
        name: `too-deep-${suffix}`,
      })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('resolves the directory owner even when a group row sorts ahead of it', async () => {
    const parentId = await seedOrganization();
    await seedSubOrganization();

    // A sub-organization inherits its parent's `directory_id`, so the directory
    // matches two live rows. Rewriting the parent's tuple moves it behind the
    // child in a sequential scan, which is enough to resolve the wrong row when
    // the lookup does not require an unparented one.
    await db
      .update(organizations)
      .set({ company_domain: `example-${suffix}.test` })
      .where(eq(organizations.id, parentId));

    const sibling = await upsertDirectorySubOrganization(`directory_group_b_${suffix}`, {
      directoryId,
      directoryIdpId: `idp_group_b_${suffix}`,
      name: `kilo-admins-${suffix}`,
    });
    trackOrganization(sibling.id);

    const [row] = await db.select().from(organizations).where(eq(organizations.id, sibling.id));
    expect(row.parent_organization_id).toBe(parentId);

    // The same ambiguity would make a replayed `dsync.activated` adopt a group.
    const replay = await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `SCIM Org ${suffix}`,
    });
    expect(replay).toEqual({ id: parentId, created: false });
  });
});

describe('upsertDirectoryUser', () => {
  test('creates a user bound to the directory user', async () => {
    const userId = await seedUser();

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));

    expect(row.external_id).toBe(externalId);
    expect(row.google_user_email).toBe(email);
    expect(row.google_user_name).toBe('Bob Bobert');
    // `createOrUpdateUser` owns this, so a directory user is billable like any
    // other account rather than carrying a placeholder.
    expect(row.stripe_customer_id).toBeTruthy();
  });

  test('is idempotent: a replayed event returns the same user', async () => {
    const first = await seedUser();
    const second = await upsertDirectoryUser(externalId, {
      email,
      firstName: 'Bob',
      lastName: 'Bobert',
      idpId: `idp_${suffix}`,
    });

    expect(second.id).toBe(first);
    expect(second.created).toBe(false);
  });

  test('adopts an existing account that matches on email', async () => {
    const existing = await upsertDirectoryUser(`directory_user_other_${suffix}`, {
      email,
      firstName: 'Bob',
      lastName: 'Bobert',
      idpId: `idp_other_${suffix}`,
    });
    createdUserIds.push(existing.id);

    const linked = await upsertDirectoryUser(externalId, {
      email,
      firstName: 'Bob',
      lastName: 'Bobert',
      idpId: `idp_${suffix}`,
    });

    expect(linked.id).toBe(existing.id);
    expect(linked.created).toBe(false);

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, linked.id));
    expect(row.external_id).toBe(externalId);
  });
});

describe('directory membership', () => {
  test('adds the member to the sub-organization and its parent', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();
    const userId = await seedUser();

    const result = await addDirectoryMembership({ directoryGroupId, externalId });

    expect(result.organizationId).toBe(childId);
    expect(result.parentOrganizationId).toBe(parentId);
    expect(result.created).toBe(true);

    const rows = await db
      .select({ organizationId: organization_memberships.organization_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));

    expect(rows.map(row => row.organizationId).toSorted()).toEqual([parentId, childId].toSorted());
  });

  test('is idempotent: a replayed add reports no change', async () => {
    await seedOrganization();
    await seedSubOrganization();
    await seedUser();

    await addDirectoryMembership({ directoryGroupId, externalId });
    const replay = await addDirectoryMembership({ directoryGroupId, externalId });

    expect(replay.created).toBe(false);
  });

  test('removal leaves the parent membership and writes a tombstone', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();
    const userId = await seedUser();
    await addDirectoryMembership({ directoryGroupId, externalId });

    await removeDirectoryMembership({ directoryGroupId, externalId });

    const remaining = await db
      .select({ organizationId: organization_memberships.organization_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));

    // Leaving one group must not revoke access to the directory's organization.
    expect(remaining.map(row => row.organizationId)).toEqual([parentId]);

    const [tombstone] = await db
      .select()
      .from(organization_membership_removals)
      .where(
        and(
          eq(organization_membership_removals.organization_id, childId),
          eq(organization_membership_removals.kilo_user_id, userId)
        )
      );

    expect(tombstone.previous_role).toBe('member');
    // The actor is the identity provider, which has no Kilo user id.
    expect(tombstone.removed_by).toBeNull();
  });

  test('a re-add clears the removal tombstone, because the directory is authoritative', async () => {
    const childId = await seedOrganization().then(async () => seedSubOrganization());
    const userId = await seedUser();
    await addDirectoryMembership({ directoryGroupId, externalId });
    await removeDirectoryMembership({ directoryGroupId, externalId });

    const readded = await addDirectoryMembership({ directoryGroupId, externalId });

    expect(readded.created).toBe(true);
    expect(readded.clearedRemovalTombstone).toBe(true);

    const tombstones = await db
      .select()
      .from(organization_membership_removals)
      .where(
        and(
          eq(organization_membership_removals.organization_id, childId),
          eq(organization_membership_removals.kilo_user_id, userId)
        )
      );

    expect(tombstones).toEqual([]);
  });

  test('rejects a membership for an unbound directory group', async () => {
    await seedUser();

    await expect(
      addDirectoryMembership({ directoryGroupId: `directory_group_absent_${suffix}`, externalId })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('rejects a membership for an unknown directory user', async () => {
    await seedOrganization();
    await seedSubOrganization();

    await expect(
      addDirectoryMembership({ directoryGroupId, externalId: `directory_user_absent_${suffix}` })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('a replayed removal reports no change', async () => {
    await seedOrganization();
    await seedSubOrganization();
    await seedUser();
    await addDirectoryMembership({ directoryGroupId, externalId });

    const first = await removeDirectoryMembership({ directoryGroupId, externalId });
    const replay = await removeDirectoryMembership({ directoryGroupId, externalId });

    expect(first.removed).toBe(true);
    expect(replay.removed).toBe(false);
  });

  test('removal converges for an unbound directory group', async () => {
    await seedUser();

    // Nothing to revoke is the state the event asks for, so this must not
    // conflict: provisioning the group would be creating rows for a departing
    // user, and a 409 would hold the Worker's cursor for an add that may never
    // arrive.
    const result = await removeDirectoryMembership({
      directoryGroupId: `directory_group_absent_${suffix}`,
      externalId,
    });

    expect(result).toEqual({
      organizationId: null,
      parentOrganizationId: null,
      kiloUserId: null,
      removed: false,
    });
  });

  test('removal converges for an unknown directory user, and provisions nobody', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();
    const absentExternalId = `directory_user_absent_${suffix}`;

    const result = await removeDirectoryMembership({
      directoryGroupId,
      externalId: absentExternalId,
    });

    expect(result).toEqual({
      organizationId: childId,
      parentOrganizationId: parentId,
      kiloUserId: null,
      removed: false,
    });

    // A user leaving the directory must never be created by their own removal.
    const users = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.external_id, absentExternalId));
    expect(users).toEqual([]);
  });
});

describe('deleteDirectorySubOrganization', () => {
  test('soft-deletes the sub-organization and is idempotent', async () => {
    await seedOrganization();
    const childId = await seedSubOrganization();

    const first = await deleteDirectorySubOrganization(directoryGroupId);
    expect(first).toEqual({ id: childId, deleted: true });

    const [row] = await db.select().from(organizations).where(eq(organizations.id, childId));
    expect(row.deleted_at).not.toBeNull();

    // A replayed deletion finds no live row, which is the idempotent repeat.
    const replay = await deleteDirectorySubOrganization(directoryGroupId);
    expect(replay.deleted).toBe(false);
  });

  test('a soft-deleted group releases its binding for a new sub-organization', async () => {
    const parentId = await seedOrganization();
    const firstChildId = await seedSubOrganization();
    await deleteDirectorySubOrganization(directoryGroupId);

    // The unique index is partial on `deleted_at IS NULL`, so the same group id
    // can bind again after a disconnect and reconnect.
    const rebound = await upsertDirectorySubOrganization(directoryGroupId, {
      directoryId,
      directoryIdpId,
      name: `kilo-users-${suffix}`,
    });
    trackOrganization(rebound.id);

    expect(rebound.created).toBe(true);
    expect(rebound.id).not.toBe(firstChildId);

    const [row] = await db.select().from(organizations).where(eq(organizations.id, rebound.id));
    expect(row.parent_organization_id).toBe(parentId);
  });
});

describe('deleteDirectoryOrganization', () => {
  test('a directory disconnect soft-deletes the organization and its groups', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();

    const result = await deleteDirectoryOrganization(directoryId);

    // A sub-organization carries its parent's `directory_id`, so the match must
    // resolve the unparented row rather than whichever row the index returns.
    expect(result).toEqual({ id: parentId, deleted: true });

    // Children go with the parent: a live group under a deleted organization
    // would keep matching group events for a directory that no longer exists.
    const live = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.directory_id, directoryId), isNull(organizations.deleted_at)));
    expect(live).toEqual([]);

    const [child] = await db.select().from(organizations).where(eq(organizations.id, childId));
    expect(child.deleted_at).not.toBeNull();

    const replay = await deleteDirectoryOrganization(directoryId);
    expect(replay.deleted).toBe(false);
  });
});

describe('live-row scoping', () => {
  test('a soft-deleted organization does not satisfy a directory lookup', async () => {
    const organizationId = await seedOrganization();
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organizationId));

    // With the only bound row soft-deleted, a group event has no parent.
    await expect(
      upsertDirectorySubOrganization(directoryGroupId, {
        directoryId,
        directoryIdpId,
        name: `orphan-${suffix}`,
      })
    ).rejects.toThrow(DirectorySyncConflictError);

    const live = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.directory_id, directoryId), isNull(organizations.deleted_at)));

    expect(live).toEqual([]);
  });
});
