import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { organization_groups, type Organization, type User } from '@kilocode/db/schema';

/**
 * The list procedure hands out the manager shape to exactly the roles the group
 * writes admit. An admin creates, updates and deletes a group, so it has to see
 * and open the same groups an owner does; a billing manager reads them without
 * editing; a plain member keeps the member shape.
 */
describe('organization groups tRPC router', () => {
  let owner: User;
  let admin: User;
  let billingManager: User;
  let member: User;
  let organization: Organization;
  let groupId: string;

  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'owner-groups@example.com',
      google_user_name: 'Owner Groups User',
      is_admin: false,
    });
    admin = await insertTestUser({
      google_user_email: 'admin-groups@example.com',
      google_user_name: 'Admin Groups User',
      is_admin: false,
    });
    billingManager = await insertTestUser({
      google_user_email: 'billing-groups@example.com',
      google_user_name: 'Billing Groups User',
      is_admin: false,
    });
    member = await insertTestUser({
      google_user_email: 'member-groups@example.com',
      google_user_name: 'Member Groups User',
      is_admin: false,
    });

    organization = await createTestOrganization('Groups Router Org', owner.id, 0, {}, false);
    await addUserToOrganization(organization.id, admin.id, 'admin');
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, member.id, 'member');

    const [group] = await db
      .insert(organization_groups)
      .values({
        organization_id: organization.id,
        name: 'Design',
        description: 'Designers',
        policies: [],
        created_by_kilo_user_id: owner.id,
      })
      .returning();
    groupId = group.id;
  });

  describe('list', () => {
    it('gives an owner the manager shape with edit', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.groups.list({
        organizationId: organization.id,
      });

      expect(result.access).toBe('manager');
      expect(result.canEdit).toBe(true);
      expect(result.groups.map(group => group.id)).toContain(groupId);
    });

    it('gives an admin the manager shape, so it can open a group it may change', async () => {
      const caller = await createCallerForUser(admin.id);

      const result = await caller.organizations.groups.list({
        organizationId: organization.id,
      });

      expect(result.access).toBe('manager');
      expect(result.canEdit).toBe(true);
      expect(result.groups.map(group => group.id)).toContain(groupId);
    });

    it('gives a billing manager the manager shape without edit', async () => {
      const caller = await createCallerForUser(billingManager.id);

      const result = await caller.organizations.groups.list({
        organizationId: organization.id,
      });

      expect(result.access).toBe('manager');
      expect(result.canEdit).toBe(false);
    });

    it('keeps a plain member on the member shape', async () => {
      const caller = await createCallerForUser(member.id);

      const result = await caller.organizations.groups.list({
        organizationId: organization.id,
      });

      expect(result.access).toBe('member');
      expect(result.canEdit).toBe(false);
    });
  });

  describe('admin group access', () => {
    it('lets an admin open and rename a group the list showed it', async () => {
      const caller = await createCallerForUser(admin.id);

      const { group } = await caller.organizations.groups.get({
        organizationId: organization.id,
        groupId,
      });
      expect(group.id).toBe(groupId);

      const { result } = await caller.organizations.groups.updateMetadata({
        organizationId: organization.id,
        groupId,
        name: 'Design renamed',
      });
      expect(result.name).toBe('Design renamed');
    });
  });
});
