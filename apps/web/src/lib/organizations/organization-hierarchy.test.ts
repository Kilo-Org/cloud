import { randomUUID } from 'crypto';
import { afterEach, describe, expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';

describe('organization hierarchy', () => {
  const createdOrganizationIds: string[] = [];

  afterEach(async () => {
    for (const organizationId of createdOrganizationIds.toReversed()) {
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    createdOrganizationIds.length = 0;
  });

  test('allows child organizations to reference a parent organization with SSO', async () => {
    const [parentOrganization] = await db
      .insert(organizations)
      .values({ name: 'Parent Organization', sso_domain: 'example.com' })
      .returning({ id: organizations.id });
    createdOrganizationIds.push(parentOrganization.id);

    const [childOrganization] = await db
      .insert(organizations)
      .values({
        name: 'Child Organization',
        parent_organization_id: parentOrganization.id,
      })
      .returning({
        id: organizations.id,
        parent_organization_id: organizations.parent_organization_id,
      });
    createdOrganizationIds.push(childOrganization.id);

    expect(childOrganization.parent_organization_id).toBe(parentOrganization.id);
  });

  test('rejects organizations that own themselves', async () => {
    const organizationId = randomUUID();

    await expect(
      db.insert(organizations).values({
        id: organizationId,
        name: 'Self Owned Organization',
        parent_organization_id: organizationId,
      })
    ).rejects.toThrow();
  });
});
