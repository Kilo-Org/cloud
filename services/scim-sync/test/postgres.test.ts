import { randomUUID } from 'node:crypto';

import { createDrizzleClient } from '@kilocode/db/client';
import {
  kilocode_users,
  organization_membership_removals,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findChildOrganizations,
  findDirectoryBoundChildOrganizations,
  findOrganizationByDirectoryGroupId,
  findOrganizationByExternalOrgId,
  findOrganizationById,
  findOrganizationsByDirectoryIdpId,
} from '../src/db/organizations';
import {
  findMembership,
  findMembershipRemoval,
  listOrganizationMemberships,
  listUserMemberships,
} from '../src/db/memberships';
import { findUserById, findUsersByExternalId, findUsersByNormalizedEmail } from '../src/db/users';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

// `createDrizzleClient` and `getWorkerDb` both wrap `drizzle(pool, { schema })`
// from `drizzle-orm/node-postgres`, so the query modules accept either.
const client = createDrizzleClient({ connectionString });
const db = client.db;

const suffix = randomUUID();
const parentOrgId = randomUUID();
const childOrgId = randomUUID();
// A sub-organization created by hand, with no directory binding. Real data has
// these: `createChildOrganization` sets no directory columns.
const manualChildOrgId = randomUUID();
const deletedOrgId = randomUUID();
// A user ID is an arbitrary string, not a UUID. Use an OAuth-shaped one so a
// stray `::uuid` cast or UUID validation would fail the test.
const userId = `oauth/scim-sync-test-${suffix}`;
const externalId = `directory_user_${suffix}`;
const directoryId = `directory_${suffix}`;
const directoryGroupId = `directory_group_${suffix}`;
const directoryIdpId = `idp_group_${suffix}`;
const externalOrgId = `external_org_${suffix}`;

const allOrgIds = [parentOrgId, childOrgId, manualChildOrgId, deletedOrgId];

beforeAll(async () => {
  await client.db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `scim-sync-${suffix}@example.test`,
    google_user_name: 'SCIM Sync Test',
    google_user_image_url: '',
    stripe_customer_id: `cus_scim_${suffix}`,
    normalized_email: `scim-sync-${suffix}@example.test`,
    external_id: externalId,
  });

  // Mirrors the real mapping: the directory binds to the parent organization,
  // and a directory group binds to a sub-organization.
  await client.db.insert(organizations).values([
    {
      id: parentOrgId,
      name: `SCIM Parent ${suffix}`,
      directory_id: directoryId,
      external_org_id: externalOrgId,
    },
    {
      id: childOrgId,
      name: `SCIM Child ${suffix}`,
      parent_organization_id: parentOrgId,
      directory_id: directoryId,
      directory_group_id: directoryGroupId,
      directory_idp_id: directoryIdpId,
    },
    // A sibling sub-organization created by hand: same parent, no directory
    // binding. Enumerating a directory's groups must not return it.
    {
      id: manualChildOrgId,
      name: `SCIM Manual Child ${suffix}`,
      parent_organization_id: parentOrgId,
    },
    // Soft-deleted, and deliberately holding the same directory-group and IdP
    // bindings as the live sub-organization. The partial unique indexes permit
    // this, so a query missing `deleted_at IS NULL` can return the wrong row.
    {
      id: deletedOrgId,
      name: `SCIM Deleted ${suffix}`,
      parent_organization_id: parentOrgId,
      directory_group_id: directoryGroupId,
      directory_idp_id: directoryIdpId,
      external_org_id: externalOrgId,
      deleted_at: new Date().toISOString(),
    },
  ]);

  await client.db.insert(organization_memberships).values({
    organization_id: parentOrgId,
    kilo_user_id: userId,
    role: 'admin',
  });

  await client.db.insert(organization_membership_removals).values({
    organization_id: childOrgId,
    kilo_user_id: userId,
    previous_role: 'member',
  });
});

afterAll(async () => {
  await client.db
    .delete(organization_membership_removals)
    .where(inArray(organization_membership_removals.organization_id, allOrgIds));
  await client.db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.organization_id, allOrgIds));
  // The self-referential foreign key is ON DELETE RESTRICT, so every child has
  // to go before the parent. Derived from `allOrgIds` rather than listed by
  // hand, so adding a fixture cannot silently break teardown.
  await client.db
    .delete(organizations)
    .where(inArray(organizations.parent_organization_id, allOrgIds));
  await client.db.delete(organizations).where(eq(organizations.id, parentOrgId));
  await client.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  await client.pool.end();
});

describe('organizations', () => {
  it('reads the parent organization and its directory binding', async () => {
    const org = await findOrganizationById(db, parentOrgId);

    expect(org?.name).toBe(`SCIM Parent ${suffix}`);
    expect(org?.directory_id).toBe(directoryId);
    expect(org?.external_org_id).toBe(externalOrgId);
    // The directory group binds to the sub-organization, not here.
    expect(org?.directory_group_id).toBeNull();
  });

  it('reads the sub-organization and its directory-group binding', async () => {
    const org = await findOrganizationById(db, childOrgId);

    expect(org?.parent_organization_id).toBe(parentOrgId);
    expect(org?.directory_group_id).toBe(directoryGroupId);
    expect(org?.directory_idp_id).toBe(directoryIdpId);
  });

  it('excludes soft-deleted organizations', async () => {
    expect(await findOrganizationById(db, deletedOrgId)).toBeNull();
  });

  it('resolves a directory group to the sub-organization, not its parent', async () => {
    // A directory group binds to a sub-organization. The parent carries only
    // the directory binding, so the group lookup must not return it.
    expect((await findOrganizationByDirectoryGroupId(db, directoryGroupId))?.id).toBe(childOrgId);
  });

  it('resolves the live row when a soft-deleted one shares the same binding', async () => {
    // The unique index is partial on `deleted_at IS NULL`, so both the live
    // sub-organization and the deleted row hold this group binding.
    expect((await findOrganizationByDirectoryGroupId(db, directoryGroupId))?.id).toBe(childOrgId);
    expect((await findOrganizationByExternalOrgId(db, externalOrgId))?.id).toBe(parentOrgId);
  });

  it('returns every live match for a non-unique IdP group id', async () => {
    const matches = await findOrganizationsByDirectoryIdpId(db, directoryIdpId);

    expect(matches.map(row => row.id)).toEqual([childOrgId]);
  });

  it('lists every sub-organization, directory-bound or not', async () => {
    const children = await findChildOrganizations(db, parentOrgId);

    expect(children.map(row => row.id).toSorted()).toEqual(
      [childOrgId, manualChildOrgId].toSorted()
    );
    // Depth is one level, so a sub-organization has no children of its own.
    expect(await findChildOrganizations(db, childOrgId)).toEqual([]);
  });

  it('lists a directory group set without the hand-made sub-organization', async () => {
    const groups = await findDirectoryBoundChildOrganizations(db, parentOrgId);

    expect(groups.map(row => row.id)).toEqual([childOrgId]);
  });
});

describe('users', () => {
  it('reads a user by its non-UUID id', async () => {
    expect((await findUserById(db, userId))?.external_id).toBe(externalId);
  });

  it('resolves a directory-provisioned user by external id', async () => {
    const matches = await findUsersByExternalId(db, externalId);

    expect(matches.map(row => row.id)).toEqual([userId]);
  });

  it('returns every match for a non-unique normalized email', async () => {
    const matches = await findUsersByNormalizedEmail(db, `scim-sync-${suffix}@example.test`);

    expect(matches.map(row => row.id)).toEqual([userId]);
  });

  it('returns null for an unknown user', async () => {
    expect(await findUserById(db, `oauth/absent-${suffix}`)).toBeNull();
    expect(await findUsersByExternalId(db, `absent_${suffix}`)).toEqual([]);
  });
});

describe('memberships', () => {
  it('reads a membership by organization and user', async () => {
    expect((await findMembership(db, parentOrgId, userId))?.role).toBe('admin');
  });

  it('lists memberships from both directions', async () => {
    expect(
      (await listOrganizationMemberships(db, parentOrgId)).map(row => row.kilo_user_id)
    ).toEqual([userId]);
    expect((await listUserMemberships(db, userId)).map(row => row.organization_id)).toEqual([
      parentOrgId,
    ]);
  });

  it('distinguishes a removal tombstone from an absent membership', async () => {
    // The child organization has a tombstone and no membership, which is how a
    // deliberate removal is told apart from never having joined.
    expect(await findMembership(db, childOrgId, userId)).toBeNull();
    expect((await findMembershipRemoval(db, childOrgId, userId))?.previous_role).toBe('member');

    expect(await findMembershipRemoval(db, parentOrgId, userId)).toBeNull();
  });
});
