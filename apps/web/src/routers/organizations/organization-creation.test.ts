import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kilocode_users,
  organization_audit_logs,
  organization_memberships,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  addUserToOrganization,
  createOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { createChildOrganization } from '@/lib/organizations/organization-hierarchy';
import { stampOrganizationTrialConsumption } from '@/scripts/db/backfill-organization-trial-consumption';
import { MAX_ORGANIZATIONS_PER_USER } from '@kilocode/web-shared/lib/organizations/organization-creation-limit';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { createCallerForUser } from '@/routers/test-utils';

jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn().mockResolvedValue('cus_test_creation'),
}));

describe('child organization Anthropic user profile', () => {
  test.each(['uprof_parent', null])(
    'copies the parent profile id %p to a new child organization',
    async parentProfileId => {
      const user = await insertTestUser();
      const parent = await createTestOrganization(
        `Profile Parent ${crypto.randomUUID()}`,
        user.id,
        0
      );
      await db
        .update(organizations)
        .set({ anthropic_user_profile_id: parentProfileId })
        .where(eq(organizations.id, parent.id));

      const child = await createChildOrganization('Profile Child', parent.id);

      expect(child.anthropic_user_profile_id).toBe(parentProfileId);
      const [persisted] = await db
        .select({ id: organizations.anthropic_user_profile_id })
        .from(organizations)
        .where(eq(organizations.id, child.id));
      expect(persisted.id).toBe(parentProfileId);
    }
  );
});

describe('organization creation limit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows the organization limit and rejects one more without creating a Stripe customer', async () => {
    const user = await insertTestUser({ id: `oauth/quota-${crypto.randomUUID()}` });
    const caller = await createCallerForUser(user.id);

    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER; index++) {
      await caller.organizations.create({ name: `Organization ${index}`, autoAddCreator: true });
    }

    await expect(
      caller.organizations.create({ name: 'Over limit', autoAddCreator: true })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    const persisted = await db.query.organizations.findMany({
      where: eq(organizations.created_by_kilo_user_id, user.id),
    });
    expect(persisted).toHaveLength(MAX_ORGANIZATIONS_PER_USER);
    const audits = await db.query.organization_audit_logs.findMany({
      where: eq(organization_audit_logs.actor_id, user.id),
    });
    expect(audits).toHaveLength(MAX_ORGANIZATIONS_PER_USER);
    expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(
      MAX_ORGANIZATIONS_PER_USER
    );
  });

  test.each([undefined, false])(
    'counts organizations with autoAddCreator=%s',
    async autoAddCreator => {
      const user = await insertTestUser();
      const caller = await createCallerForUser(user.id);

      for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER; index++) {
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
      expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(
        MAX_ORGANIZATIONS_PER_USER
      );
    }
  );

  test('counts a parent and its children together without requiring child memberships', async () => {
    const user = await insertTestUser();
    const parent = await createOrganization('Parent', user.id);
    const caller = await createCallerForUser(user.id);

    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER - 1; index++) {
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
    expect(children).toHaveLength(MAX_ORGANIZATIONS_PER_USER - 1);
    expect(children.every(child => child.created_by_kilo_user_id === null)).toBe(true);
    const memberships = await db.query.organization_memberships.findMany({
      where: eq(organization_memberships.kilo_user_id, user.id),
    });
    expect(memberships).toHaveLength(1);
    expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(
      MAX_ORGANIZATIONS_PER_USER - 1
    );
  });

  test('blocks further self-service creation for an existing account above the limit', async () => {
    const user = await insertTestUser();
    const parent = await createTestOrganization('Existing oversized parent', user.id, 0);
    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER; index++) {
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
    expect(persisted).toHaveLength(MAX_ORGANIZATIONS_PER_USER + 1);
    expect(memberships).toHaveLength(MAX_ORGANIZATIONS_PER_USER + 1);
    expect(getOrCreateStripeCustomerIdForOrganization).not.toHaveBeenCalled();
  });

  test('counts existing children inherited by a parent admin who did not create them', async () => {
    const owner = await insertTestUser();
    const admin = await insertTestUser();
    const parent = await createOrganization('Inherited Parent', owner.id);
    await addUserToOrganization(parent.id, admin.id, 'admin');
    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER - 1; index++) {
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
    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER - 2; index++) {
      await createChildOrganization(`Shared Existing ${index}`, parent.id);
    }

    const ownerCaller = await createCallerForUser(owner.id);
    const adminCaller = await createCallerForUser(admin.id);
    await ownerCaller.organizations.create({
      name: 'Owner organization at the limit',
      autoAddCreator: true,
    });
    await adminCaller.organizations.createChild({
      organizationId: parent.id,
      name: 'Admin organization at the limit',
    });

    const ownerOrganizations = await db.query.organizations.findMany({
      where: or(
        eq(organizations.created_by_kilo_user_id, owner.id),
        eq(organizations.parent_organization_id, parent.id)
      ),
    });
    expect(ownerOrganizations).toHaveLength(MAX_ORGANIZATIONS_PER_USER + 1);
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
    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER - 2; index++) {
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
    expect(persisted).toHaveLength(MAX_ORGANIZATIONS_PER_USER);
    expect(getOrCreateStripeCustomerIdForOrganization).toHaveBeenCalledTimes(1);
  });

  test('does not exempt an email domain that only ends with kilocode.ai', async () => {
    const user = await insertTestUser({
      google_user_email: `external-${crypto.randomUUID()}@notkilocode.ai`,
    });
    const caller = await createCallerForUser(user.id);
    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER; index++) {
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
      for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER + 1; index++) {
        await caller.organizations.create({ name: `Staff ${index}`, autoAddCreator: true });
      }

      const persisted = await db.query.organizations.findMany({
        where: eq(organizations.created_by_kilo_user_id, user.id),
      });
      expect(persisted).toHaveLength(MAX_ORGANIZATIONS_PER_USER + 1);
    }
  );

  test('preserves trusted admin creation above the self-service limit', async () => {
    const user = await insertTestUser({ is_admin: true });
    const parent = await createOrganization('Admin Parent', user.id);
    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER - 1; index++) {
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
    for (let index = 0; index < MAX_ORGANIZATIONS_PER_USER; index++) {
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

describe('organization trial eligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('grants a trial window to the first organization a user creates', async () => {
    const user = await insertTestUser();

    const organization = await createOrganization('First Organization', user.id);

    expect(organization.trial_granted).toBe(true);
    expect(organization.free_trial_end_at).not.toBeNull();
    expect(new Date(organization.free_trial_end_at ?? 0).getTime()).toBeGreaterThan(Date.now());
  });

  test('grants a trial to every organization an internal staff account creates', async () => {
    const user = await insertTestUser({
      google_user_email: `staff-${crypto.randomUUID()}@kilocode.ai`,
    });

    const first = await createOrganization('First Staff Organization', user.id);
    const second = await createOrganization('Second Staff Organization', user.id);

    for (const organization of [first, second]) {
      expect(organization.trial_granted).toBe(true);
      expect(organization.free_trial_end_at).not.toBeNull();
      expect(new Date(organization.free_trial_end_at ?? 0).getTime()).toBeGreaterThan(Date.now());
    }
  });

  test('creates later organizations without a trial until a seat is purchased', async () => {
    const user = await insertTestUser();
    await createOrganization('First Organization', user.id);

    const second = await createOrganization('Second Organization', user.id);

    expect(second.trial_granted).toBe(false);
    expect(second.free_trial_end_at).toBeNull();
    await expect(requireActiveSubscriptionOrTrial(second.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    await db.insert(organization_seats_purchases).values({
      organization_id: second.id,
      subscription_stripe_id: `sub_${crypto.randomUUID()}`,
      seat_count: 1,
      amount_usd: 30,
      starts_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      subscription_status: 'active',
    });

    await expect(requireActiveSubscriptionOrTrial(second.id)).resolves.toMatchObject({
      isReadOnly: false,
    });
  });

  test('does not restore the trial after the earlier organization is deleted', async () => {
    const user = await insertTestUser();
    const first = await createOrganization('First Organization', user.id);
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, first.id));

    const replacement = await createOrganization('Replacement Organization', user.id);

    expect(replacement.trial_granted).toBe(false);
    expect(replacement.free_trial_end_at).toBeNull();
  });

  test('does not grant another trial after a sales demo organization', async () => {
    const user = await insertTestUser();
    await db.insert(organizations).values({
      name: 'Sales Demo',
      plan: 'enterprise',
      require_seats: false,
      created_by_kilo_user_id: user.id,
      free_trial_end_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      trial_granted: true,
      settings: { is_sales_demo: true, suppress_trial_messaging: true },
    });
    // `createSalesDemoOrganization` stamps the target user's row. The direct
    // insert above bypasses it, so stamp the same record here.
    await db
      .update(kilocode_users)
      .set({ organization_trial_consumed_at: new Date().toISOString() })
      .where(eq(kilocode_users.id, user.id));

    const later = await createOrganization('After Demo', user.id);

    expect(later.trial_granted).toBe(false);
    expect(later.free_trial_end_at).toBeNull();
  });

  test('keeps a trial window on a creation with no creator', async () => {
    const organization = await createOrganization('Admin Organization');

    expect(organization.trial_granted).toBe(true);
    expect(organization.free_trial_end_at).not.toBeNull();
    expect(organization.created_by_kilo_user_id).toBeNull();
    expect(new Date(organization.free_trial_end_at ?? 0).getTime()).toBeGreaterThan(Date.now());
  });

  test('records trial consumption on the creator, so an assigned organization does not consume their offer', async () => {
    const userA = await insertTestUser();
    const userB = await insertTestUser();

    const organization = await createOrganization('Assigned Organization', userA.id);
    expect(organization.trial_granted).toBe(true);

    await db
      .update(organizations)
      .set({ created_by_kilo_user_id: userB.id })
      .where(eq(organizations.id, organization.id));

    const second = await createOrganization('Second Organization', userB.id);

    expect(second.trial_granted).toBe(true);
    expect(second.free_trial_end_at).not.toBeNull();
  });

  test('keeps the offer consumed after the creator is cleared', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Cleared Organization', user.id);
    expect(organization.trial_granted).toBe(true);

    await db
      .update(organizations)
      .set({ created_by_kilo_user_id: null })
      .where(eq(organizations.id, organization.id));

    const second = await createOrganization('Second Organization', user.id);

    expect(second.trial_granted).toBe(false);
    expect(second.free_trial_end_at).toBeNull();
  });

  test('records the consumption timestamp once', async () => {
    const user = await insertTestUser();
    await createOrganization('First Organization', user.id);

    const [firstRead] = await db
      .select({ organization_trial_consumed_at: kilocode_users.organization_trial_consumed_at })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(firstRead.organization_trial_consumed_at).not.toBeNull();

    await createOrganization('Second Organization', user.id);

    const [secondRead] = await db
      .select({ organization_trial_consumed_at: kilocode_users.organization_trial_consumed_at })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(secondRead.organization_trial_consumed_at).toBe(
      firstRead.organization_trial_consumed_at
    );
  });
});

describe('organization trial consumption backfill', () => {
  // The statement the migration runs, and the one the post-deploy script repeats.
  const stamp = () => db.transaction(tx => stampOrganizationTrialConsumption(tx));

  async function readTrialConsumedAt(userId: string) {
    const [row] = await db
      .select({ organization_trial_consumed_at: kilocode_users.organization_trial_consumed_at })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId));
    return row?.organization_trial_consumed_at ?? null;
  }

  test('stamps the creator of an organization created before the record existed', async () => {
    const user = await insertTestUser();
    // The organization carries a granted trial and its creator's record is unset, which is
    // the state an organization created before the record existed leaves behind.
    const [windowOrganization] = await db
      .insert(organizations)
      .values({
        name: 'Deploy window organization',
        created_by_kilo_user_id: user.id,
        trial_granted: true,
        free_trial_end_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .returning();
    expect(windowOrganization.trial_granted).toBe(true);
    expect(await readTrialConsumedAt(user.id)).toBeNull();

    expect(await stamp()).toBeGreaterThan(0);
    expect(await readTrialConsumedAt(user.id)).not.toBeNull();

    const later = await createOrganization('After the window', user.id);

    expect(later.trial_granted).toBe(false);
    expect(later.free_trial_end_at).toBeNull();
  });

  test('stamps nothing on a repeat run', async () => {
    const user = await insertTestUser();
    await db.insert(organizations).values({
      name: 'Repeat run organization',
      created_by_kilo_user_id: user.id,
      trial_granted: true,
    });

    expect(await stamp()).toBeGreaterThan(0);
    const stampedAt = await readTrialConsumedAt(user.id);
    expect(stampedAt).not.toBeNull();

    expect(await stamp()).toBe(0);
    expect(await readTrialConsumedAt(user.id)).toBe(stampedAt);
  });

  test('does not stamp a user who only joined a granted-trial organization another user created', async () => {
    const creator = await insertTestUser();
    const joined = await insertTestUser();
    const organization = await createOrganization('Joined organization', creator.id);
    expect(organization.trial_granted).toBe(true);
    await addUserToOrganization(organization.id, joined.id, 'owner');

    await stamp();

    expect(await readTrialConsumedAt(creator.id)).not.toBeNull();
    expect(await readTrialConsumedAt(joined.id)).toBeNull();
  });

  test('does not stamp a creator from an organization that carried no trial', async () => {
    const user = await insertTestUser();
    await db.insert(organizations).values({
      name: 'No trial organization',
      created_by_kilo_user_id: user.id,
      trial_granted: false,
    });

    await stamp();

    expect(await readTrialConsumedAt(user.id)).toBeNull();
  });
});

describe('child organization plan inheritance', () => {
  async function createParentWithPlan(plan: 'enterprise' | 'teams') {
    const user = await insertTestUser();
    const parent = await createOrganization(`${plan} parent`, user.id);
    await db.update(organizations).set({ plan }).where(eq(organizations.id, parent.id));
    return { user, parent };
  }

  async function getPersistedPlan(organizationId: string) {
    const organization = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    return organization?.plan;
  }

  test.each(['enterprise', 'teams'] as const)(
    'creates a self-service child of a %s parent on the parent plan',
    async plan => {
      const { user, parent } = await createParentWithPlan(plan);
      const caller = await createCallerForUser(user.id);

      const child = await caller.organizations.createChild({
        organizationId: parent.id,
        name: `${plan} child`,
      });

      expect(await getPersistedPlan(child.organization.id)).toBe(plan);
    }
  );

  test.each(['enterprise', 'teams'] as const)(
    'creates a helper-created child of a %s parent on the parent plan',
    async plan => {
      const { parent } = await createParentWithPlan(plan);

      const child = await createChildOrganization(`${plan} helper child`, parent.id);

      expect(child.plan).toBe(plan);
      expect(await getPersistedPlan(child.id)).toBe(plan);
    }
  );
});
