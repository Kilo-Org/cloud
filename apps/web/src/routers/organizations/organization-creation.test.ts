import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  organization_audit_logs,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq, or } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  addUserToOrganization,
  createOrganization,
  markOrganizationAsDeleted,
} from '@kilocode/web-shared/lib/organizations/organizations';
import {
  getDaysRemainingInTrial,
  getOrgTrialStatusFromDays,
} from '@kilocode/organization-entitlement';
import { createChildOrganization } from '@/lib/organizations/organization-hierarchy';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { createCallerForUser } from '@/routers/test-utils';

jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn().mockResolvedValue('cus_test_creation'),
}));

// Entitlement classification the way the app reads it, so a case asserts the
// stage an organization lands in rather than only the raw timestamp.
function trialStatusOf(organization: { free_trial_end_at: string | null; created_at: string }) {
  return getOrgTrialStatusFromDays(
    getDaysRemainingInTrial(organization.free_trial_end_at, organization.created_at)
  );
}

describe('organization creation limit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows five organizations and rejects a sixth without creating a Stripe customer', async () => {
    const user = await insertTestUser({ id: `oauth/quota-${crypto.randomUUID()}` });
    const caller = await createCallerForUser(user.id);

    for (let index = 0; index < 5; index++) {
      await caller.organizations.create({ name: `Organization ${index}`, autoAddCreator: true });
    }

    await expect(
      caller.organizations.create({ name: 'Over limit', autoAddCreator: true })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    const persisted = await db.query.organizations.findMany({
      where: eq(organizations.created_by_kilo_user_id, user.id),
    });
    expect(persisted).toHaveLength(5);
    const audits = await db.query.organization_audit_logs.findMany({
      where: eq(organization_audit_logs.actor_id, user.id),
    });
    expect(audits).toHaveLength(5);
    expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(5);
  });

  test.each([undefined, false])(
    'counts organizations with autoAddCreator=%s',
    async autoAddCreator => {
      const user = await insertTestUser();
      const caller = await createCallerForUser(user.id);

      for (let index = 0; index < 5; index++) {
        await caller.organizations.create({ name: `Unassigned ${index}`, autoAddCreator });
      }

      await expect(
        caller.organizations.create({ name: 'Unassigned over limit' })
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
      const memberships = await db.query.organization_memberships.findMany({
        where: eq(organization_memberships.kilo_user_id, user.id),
      });
      expect(memberships).toHaveLength(0);
      expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(5);
    }
  );

  test('counts a parent and its children together without requiring child memberships', async () => {
    const user = await insertTestUser();
    const parent = await createOrganization('Parent', user.id);
    const caller = await createCallerForUser(user.id);

    for (let index = 0; index < 4; index++) {
      await caller.organizations.createChild({ organizationId: parent.id, name: `Child ${index}` });
    }

    await expect(
      caller.organizations.createChild({ organizationId: parent.id, name: 'Child over limit' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(caller.organizations.create({ name: 'Parent over limit' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });

    const children = await db.query.organizations.findMany({
      where: eq(organizations.parent_organization_id, parent.id),
    });
    expect(children).toHaveLength(4);
    expect(children.every(child => child.created_by_kilo_user_id === null)).toBe(true);
    const memberships = await db.query.organization_memberships.findMany({
      where: eq(organization_memberships.kilo_user_id, user.id),
    });
    expect(memberships).toHaveLength(1);
    expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(4);
  });

  test('blocks further self-service creation for an existing account above the limit', async () => {
    const user = await insertTestUser();
    const parent = await createTestOrganization('Existing oversized parent', user.id, 0);
    for (let index = 0; index < 5; index++) {
      await createTestOrganization(`Existing oversized ${index}`, user.id, 0);
    }

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.create({ name: 'Over existing limit' })
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(
      caller.organizations.createChild({
        organizationId: parent.id,
        name: 'Over existing child limit',
      })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    const persisted = await db.query.organizations.findMany({
      where: eq(organizations.created_by_kilo_user_id, user.id),
    });
    const memberships = await db.query.organization_memberships.findMany({
      where: eq(organization_memberships.kilo_user_id, user.id),
    });
    expect(persisted).toHaveLength(6);
    expect(memberships).toHaveLength(6);
    expect(getOrCreateStripeCustomerIdForOrganization).not.toHaveBeenCalled();
  });

  test('counts existing children inherited by a parent admin who did not create them', async () => {
    const owner = await insertTestUser();
    const admin = await insertTestUser();
    const parent = await createOrganization('Inherited Parent', owner.id);
    await addUserToOrganization(parent.id, admin.id, 'admin');
    for (let index = 0; index < 4; index++) {
      await createChildOrganization(`Existing Child ${index}`, parent.id);
    }

    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.organizations.createChild({
        organizationId: parent.id,
        name: 'Admin child over limit',
      })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(
      caller.organizations.create({ name: 'Admin parent over limit' })
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  test('rejects further creation after another admin increases inherited access', async () => {
    const owner = await insertTestUser();
    const admin = await insertTestUser();
    const parent = await createOrganization('Shared Parent', owner.id);
    await addUserToOrganization(parent.id, admin.id, 'admin');
    for (let index = 0; index < 3; index++) {
      await createChildOrganization(`Shared Existing ${index}`, parent.id);
    }

    const ownerCaller = await createCallerForUser(owner.id);
    const adminCaller = await createCallerForUser(admin.id);
    await ownerCaller.organizations.create({
      name: 'Owner fifth organization',
      autoAddCreator: true,
    });
    await adminCaller.organizations.createChild({
      organizationId: parent.id,
      name: 'Admin fifth organization',
    });

    const ownerOrganizations = await db.query.organizations.findMany({
      where: or(
        eq(organizations.created_by_kilo_user_id, owner.id),
        eq(organizations.parent_organization_id, parent.id)
      ),
    });
    expect(ownerOrganizations).toHaveLength(6);
    await expect(
      ownerCaller.organizations.create({ name: 'Owner over inherited limit' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    for (const caller of [ownerCaller, adminCaller]) {
      await expect(
        caller.organizations.createChild({
          organizationId: parent.id,
          name: 'Over inherited child limit',
        })
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    }
  });

  test('serializes concurrent parent and child creation at the shared limit', async () => {
    const user = await insertTestUser();
    const parent = await createOrganization('Concurrent Parent', user.id);
    const caller = await createCallerForUser(user.id);
    for (let index = 0; index < 3; index++) {
      await caller.organizations.createChild({
        organizationId: parent.id,
        name: `Existing ${index}`,
      });
    }
    jest.mocked(getOrCreateStripeCustomerIdForOrganization).mockClear();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        index % 2 === 0
          ? caller.organizations.create({
              name: `Concurrent Parent ${index}`,
              autoAddCreator: true,
            })
          : caller.organizations.createChild({
              organizationId: parent.id,
              name: `Concurrent Child ${index}`,
            })
      )
    );

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      }
    }
    const persisted = await db.query.organizations.findMany({
      where: or(
        eq(organizations.created_by_kilo_user_id, user.id),
        eq(organizations.parent_organization_id, parent.id)
      ),
    });
    expect(persisted).toHaveLength(5);
    expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(1);
  });

  test('does not exempt an email domain that only ends with kilocode.ai', async () => {
    const user = await insertTestUser({
      google_user_email: `external-${crypto.randomUUID()}@notkilocode.ai`,
    });
    const caller = await createCallerForUser(user.id);
    for (let index = 0; index < 5; index++) {
      await createOrganization(`External ${index}`, user.id);
    }

    await expect(
      caller.organizations.create({ name: 'Spoofed staff domain' })
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  test.each(['kilocode.ai', 'KILOCODE.AI'])(
    'preserves the exemption for the staff domain %s',
    async domain => {
      const user = await insertTestUser({
        google_user_email: `staff-${crypto.randomUUID()}@${domain}`,
      });
      const caller = await createCallerForUser(user.id);
      for (let index = 0; index < 6; index++) {
        await caller.organizations.create({ name: `Staff ${index}`, autoAddCreator: true });
      }

      const persisted = await db.query.organizations.findMany({
        where: eq(organizations.created_by_kilo_user_id, user.id),
      });
      expect(persisted).toHaveLength(6);
    }
  );

  test('preserves trusted admin creation above the self-service limit', async () => {
    const user = await insertTestUser({ is_admin: true });
    const parent = await createOrganization('Admin Parent', user.id);
    for (let index = 0; index < 4; index++) {
      await createOrganization(`Admin Existing ${index}`, user.id);
    }
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.organizations.create({ name: 'Self-service over limit' })
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(
      caller.organizations.createChild({
        name: 'Self-service child over limit',
        organizationId: parent.id,
      })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(
      caller.organizations.admin.create({ name: 'Admin Created Parent' })
    ).resolves.toMatchObject({
      organization: { name: 'Admin Created Parent', parent_organization_id: null },
    });
    await expect(
      caller.organizations.admin.create({
        name: 'Admin Created Child',
        parentOrganizationId: parent.id,
      })
    ).resolves.toMatchObject({
      organization: { name: 'Admin Created Child', parent_organization_id: parent.id },
    });
  });

  test('does not expose trusted admin creation to ordinary users', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.organizations.admin.create({ name: 'Unauthorized Admin Create' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('counts organizations the user created even after they are deleted', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);
    for (let index = 0; index < 5; index++) {
      await createOrganization(`Deleted ${index}`, user.id);
    }
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.created_by_kilo_user_id, user.id));

    await expect(
      caller.organizations.create({ name: 'Over creation history', autoAddCreator: true })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    const persisted = await db.query.organizations.findMany({
      where: eq(organizations.created_by_kilo_user_id, user.id),
    });
    expect(persisted).toHaveLength(5);
  });

  test('memberships in deleted organizations do not count toward the limit', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const deleted = await createOrganization('Deleted member org', owner.id);
    await addUserToOrganization(deleted.id, member.id, 'member');
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, deleted.id));

    const caller = await createCallerForUser(member.id);
    for (let index = 0; index < 5; index++) {
      await caller.organizations.create({ name: `Member org ${index}`, autoAddCreator: true });
    }

    const persisted = await db.query.organizations.findMany({
      where: eq(organizations.created_by_kilo_user_id, member.id),
    });
    expect(persisted).toHaveLength(5);
  });

  test('grants the trial window only on the first organization a user creates', async () => {
    const user = await insertTestUser();
    const first = await createOrganization('First organization', user.id);
    const second = await createOrganization('Second organization', user.id);

    const firstTrial = new Date(first.free_trial_end_at!).getTime();
    const secondTrial = new Date(second.free_trial_end_at!).getTime();
    expect(firstTrial).toBeGreaterThan(Date.now());
    expect(secondTrial).toBeLessThan(Date.now());
    expect(trialStatusOf(first)).toBe('trial_active');
    expect(trialStatusOf(second)).toBe('trial_expired_hard');
  });

  test('a re-created organization after deletion does not regain the trial window', async () => {
    const user = await insertTestUser();
    const original = await createOrganization('Original organization', user.id);
    expect(new Date(original.free_trial_end_at!).getTime()).toBeGreaterThan(Date.now());
    expect(trialStatusOf(original)).toBe('trial_active');

    await markOrganizationAsDeleted(original.id);

    const replacement = await createOrganization('Replacement organization', user.id);
    expect(new Date(replacement.free_trial_end_at!).getTime()).toBeLessThan(Date.now());
    expect(trialStatusOf(replacement)).toBe('trial_expired_hard');
  });

  test('each user gets their own first-organization trial window', async () => {
    const userA = await insertTestUser();
    const userB = await insertTestUser();
    await createOrganization('User A organization', userA.id);
    const firstForB = await createOrganization('User B organization', userB.id);

    expect(new Date(firstForB.free_trial_end_at!).getTime()).toBeGreaterThan(Date.now());
  });
});
