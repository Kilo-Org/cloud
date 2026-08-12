import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { createOrganization } from '@/lib/organizations/organizations';
import {
  ensureMockOrganizationMembers,
  ensureMockSubOrganizations,
} from '@/scripts/usage/generate-org-data';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('generate-org-data fixtures', () => {
  let owner: User;
  let parent: Organization;
  let childIds: string[] = [];
  const mockUserIds: string[] = [];

  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: `generate-org-data-${crypto.randomUUID()}@example.com`,
    });
    parent = await createOrganization('Usage fixture parent', owner.id);
  });

  afterAll(async () => {
    const organizationIds = [parent.id, ...childIds];
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, organizationIds));
    if (childIds.length > 0) {
      await db.delete(organizations).where(inArray(organizations.id, childIds));
    }
    await db.delete(organizations).where(eq(organizations.id, parent.id));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [owner.id, ...mockUserIds]));
  });

  it('reuses deterministic sub-organizations and users across runs', async () => {
    const firstChildren = await ensureMockSubOrganizations(parent);
    const secondChildren = await ensureMockSubOrganizations(parent);
    childIds = firstChildren.map(child => child.id);

    expect(secondChildren.map(child => child.id)).toEqual(childIds);
    expect(new Set(childIds).size).toBe(3);

    for (const child of firstChildren) {
      const firstMembers = await ensureMockOrganizationMembers(child.id, 8, true);
      const secondMembers = await ensureMockOrganizationMembers(child.id, 8, true);
      const firstUserIds = firstMembers.members.map(member => member.userId);
      mockUserIds.push(...firstUserIds);

      expect(firstMembers.created).toHaveLength(8);
      expect(secondMembers.created).toHaveLength(0);
      expect(secondMembers.members.map(member => member.userId)).toEqual(firstUserIds);

      const roles = await db
        .select({ role: organization_memberships.role })
        .from(organization_memberships)
        .where(eq(organization_memberships.organization_id, child.id));
      expect(roles.filter(row => row.role === 'owner')).toHaveLength(1);
      expect(roles.filter(row => row.role === 'billing_manager')).toHaveLength(1);
      expect(roles.filter(row => row.role === 'member')).toHaveLength(6);
    }

    const directChildren = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.parent_organization_id, parent.id));
    expect(directChildren).toHaveLength(3);
  });
});
