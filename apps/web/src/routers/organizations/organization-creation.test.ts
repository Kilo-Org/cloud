import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  organization_audit_logs,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  addUserToOrganization,
  createOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { createChildOrganization } from '@/lib/organizations/organization-hierarchy';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { createCallerForUser } from '@/routers/test-utils';

jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn().mockResolvedValue('cus_test_creation'),
}));

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
    expect(children.every(child => child.created_by_kilo_user_id === user.id)).toBe(true);
    const memberships = await db.query.organization_memberships.findMany({
      where: eq(organization_memberships.kilo_user_id, user.id),
    });
    expect(memberships).toHaveLength(1);
    expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(4);
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

  test('does not count deleted organizations against the existing active-organization limit', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);
    for (let index = 0; index < 5; index++) {
      await createOrganization(`Deleted ${index}`, user.id);
    }
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.created_by_kilo_user_id, user.id));

    await caller.organizations.create({ name: 'Replacement', autoAddCreator: true });

    const active = await db.query.organizations.findMany({
      where: and(
        eq(organizations.created_by_kilo_user_id, user.id),
        isNull(organizations.deleted_at)
      ),
    });
    expect(active).toHaveLength(1);
  });
});
