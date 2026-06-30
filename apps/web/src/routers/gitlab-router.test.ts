import { beforeAll, describe, expect, it } from '@jest/globals';
import { platform_integrations, type Organization, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

let organization: Organization;
let member: User;

beforeAll(async () => {
  const owner = await insertTestUser();
  member = await insertTestUser();
  organization = await createOrganization(`GitLab router ${crypto.randomUUID()}`, owner.id);
  await addUserToOrganization(organization.id, member.id, 'member');
});

describe('gitlabRouter.getInstallation', () => {
  it('allows organization members to read installation status', async () => {
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.gitlab.getInstallation({ organizationId: organization.id })
    ).resolves.toEqual({ installed: false, installation: null });
  });

  it.each([
    ['suspended_at', { suspended_at: new Date().toISOString() }],
    ['auth_invalid_at', { auth_invalid_at: new Date().toISOString() }],
  ] as const)('does not report an integration with %s as installed', async (_field, state) => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organization.id,
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_installation_id: crypto.randomUUID(),
      integration_status: 'active',
      repository_access: 'all',
      ...state,
    });
    const caller = await createCallerForUser(member.id);

    const result = await caller.gitlab.getInstallation({ organizationId: organization.id });

    expect(result.installed).toBe(false);
    expect(result.installation).not.toBeNull();
  });
});
