import { randomUUID } from 'node:crypto';

import { createDrizzleClient } from '@kilocode/db/client';
import {
  kilocode_users,
  organization_group_memberships,
  organization_groups,
  organization_membership_removals,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findChildOrganizations,
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
import { listGroupMemberships, listOrganizationGroups } from '../src/db/groups';
import { findUserByNormalizedEmail, findUserById, findUsersByExternalId } from '../src/db/users';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

// `createDrizzleClient` and `getWorkerDb` both wrap `drizzle(pool, { schema })`
// from `drizzle-orm/node-postgres`, so the query modules accept either.
const client = createDrizzleClient({ connectionString });
const db = client.db;

const suffix = randomUUID();
const parentOrgId = randomUUID();
const childOrgId = randomUUID();
const deletedOrgId = randomUUID();
// A user ID is an arbitrary string, not a UUID. Use an OAuth-shaped one so a
// stray `::uuid` cast or UUID validation would fail the test.
const userId = `oauth/scim-sync-test-${suffix}`;
const externalId = `directory_user_${suffix}`;
const directoryGroupId = `directory_group_${suffix}`;
const directoryIdpId = `idp_group_${suffix}`;
const externalOrgId = `external_org_${suffix}`;
const groupId = randomUUID();

const allOrgIds = [parentOrgId, childOrgId, deletedOrgId];

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

  await client.db.insert(organizations).values([
    {
      id: parentOrgId,
      name: `SCIM Parent ${suffix}`,
      directory_group_id: directoryGroupId,
      directory_idp_id: directoryIdpId,
      external_org_id: externalOrgId,
    },
    {
      id: childOrgId,
      name: `SCIM Child ${suffix}`,
      parent_organization_id: parentOrgId,
    },
    // Soft-deleted, and deliberately holding the same directory and IdP
    // bindings as the live parent. The partial unique indexes permit this, so
    // a query missing `deleted_at IS NULL` can return the wrong row.
    {
      id: deletedOrgId,
      name: `SCIM Deleted ${suffix}`,
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

  await client.db.insert(organization_groups).values({
    id: groupId,
    organization_id: parentOrgId,
    name: `Engineering ${suffix}`,
  });

  await client.db.insert(organization_group_memberships).values({
    organization_id: parentOrgId,
    group_id: groupId,
    kilo_user_id: userId,
  });

  await client.db.insert(organization_membership_removals).values({
    organization_id: childOrgId,
    kilo_user_id: userId,
    previous_role: 'member',
  });
});

afterAll(async () => {
  await client.db
    .delete(organization_group_memberships)
    .where(inArray(organization_group_memberships.organization_id, allOrgIds));
  await client.db.delete(organization_groups).where(inArray(organization_groups.id, [groupId]));
  await client.db
    .delete(organization_membership_removals)
    .where(inArray(organization_membership_removals.organization_id, allOrgIds));
  await client.db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.organization_id, allOrgIds));
  await client.db
    .delete(organizations)
    .where(inArray(organizations.id, [childOrgId, deletedOrgId]));
  await client.db.delete(organizations).where(eq(organizations.id, parentOrgId));
  await client.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  await client.pool.end();
});

describe('organizations', () => {
  it('reads a live organization and its WorkOS bindings', async () => {
    const org = await findOrganizationById(db, parentOrgId);

    expect(org?.name).toBe(`SCIM Parent ${suffix}`);
    expect(org?.directory_group_id).toBe(directoryGroupId);
    expect(org?.external_org_id).toBe(externalOrgId);
  });

  it('excludes soft-deleted organizations', async () => {
    expect(await findOrganizationById(db, deletedOrgId)).toBeNull();
  });

  it('resolves the live organization when a soft-deleted one shares its directory binding', async () => {
    // The unique index is partial on `deleted_at IS NULL`, so both rows hold
    // this binding and only the live one may be returned.
    expect((await findOrganizationByDirectoryGroupId(db, directoryGroupId))?.id).toBe(parentOrgId);
    expect((await findOrganizationByExternalOrgId(db, externalOrgId))?.id).toBe(parentOrgId);
  });

  it('returns every live match for a non-unique IdP group id', async () => {
    const matches = await findOrganizationsByDirectoryIdpId(db, directoryIdpId);

    expect(matches.map(row => row.id)).toEqual([parentOrgId]);
  });

  it('finds child organizations by parent', async () => {
    const children = await findChildOrganizations(db, parentOrgId);

    expect(children.map(row => row.id)).toEqual([childOrgId]);
    expect(await findChildOrganizations(db, childOrgId)).toEqual([]);
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

  it('reads a user by normalized email', async () => {
    const found = await findUserByNormalizedEmail(db, `scim-sync-${suffix}@example.test`);

    expect(found?.id).toBe(userId);
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

describe('groups', () => {
  it('lists an organization group and its members', async () => {
    expect((await listOrganizationGroups(db, parentOrgId)).map(row => row.id)).toEqual([groupId]);
    expect(
      (await listGroupMemberships(db, parentOrgId, groupId)).map(row => row.kilo_user_id)
    ).toEqual([userId]);
  });
});
