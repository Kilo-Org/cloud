import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { Organization, User } from '@kilocode/db/schema';
import {
  credit_transactions,
  kilo_pass_org_agreements,
  kilocode_users,
  organization_invitations,
  organization_memberships,
  organization_user_limits,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { createPendingAgreement } from '@/lib/kilo-pass-org/service';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('organization sub-organizations router', () => {
  let owner: User;
  let billingManager: User;
  let organizationAdmin: User;
  let member: User;
  let childOwner: User;
  let childMember: User;
  let childBillingManager: User;
  let bot: User;
  let unrelatedOwner: User;
  let parent: Organization;
  let childA: Organization;
  let childB: Organization;
  let unrelatedOrganization: Organization;

  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    [
      owner,
      billingManager,
      organizationAdmin,
      member,
      childOwner,
      childMember,
      childBillingManager,
      bot,
      unrelatedOwner,
    ] = await Promise.all([
      insertTestUser({ google_user_email: `suborg-owner-${suffix}@example.com` }),
      insertTestUser({ google_user_email: `suborg-billing-${suffix}@example.com` }),
      insertTestUser({ google_user_email: `suborg-admin-${suffix}@example.com` }),
      insertTestUser({ google_user_email: `suborg-member-${suffix}@example.com` }),
      insertTestUser({ google_user_email: `suborg-child-owner-${suffix}@example.com` }),
      insertTestUser({ google_user_email: `suborg-child-member-${suffix}@example.com` }),
      insertTestUser({ google_user_email: `suborg-child-billing-${suffix}@example.com` }),
      insertTestUser({
        google_user_email: `suborg-bot-${suffix}@example.com`,
        is_bot: true,
      }),
      insertTestUser({ google_user_email: `suborg-unrelated-${suffix}@example.com` }),
    ]);

    parent = await createOrganization('Suborg parent', owner.id);
    childA = await createOrganization('Alpha child', childOwner.id);
    childB = await createOrganization('Beta child', unrelatedOwner.id);
    unrelatedOrganization = await createOrganization('Unrelated organization', unrelatedOwner.id);

    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(inArray(organizations.id, [childA.id, childB.id]));
    await db
      .update(organizations)
      .set({
        seat_count: 8,
        total_microdollars_acquired: 5_000_000,
        microdollars_used: 1_250_000,
        next_credit_expiration_at: null,
        settings: {
          ...childA.settings,
          minimum_balance: 4,
          provider_allow_list: ['openai'],
          model_deny_list: ['test/denied'],
          enable_usage_limits: true,
          projects_ui_enabled: true,
          data_collection: 'deny',
        },
      })
      .where(eq(organizations.id, childA.id));

    await addUserToOrganization(parent.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(parent.id, organizationAdmin.id, 'admin');
    await addUserToOrganization(parent.id, member.id, 'member');
    await addUserToOrganization(childA.id, childMember.id, 'member');
    await addUserToOrganization(childA.id, childBillingManager.id, 'billing_manager');
    await addUserToOrganization(childA.id, bot.id, 'member');
    await addUserToOrganization(childB.id, childMember.id, 'member');
    await db.insert(organization_user_limits).values({
      organization_id: childA.id,
      kilo_user_id: childMember.id,
      limit_type: 'daily',
      microdollar_limit: 1_500_000,
    });

    const invitationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.insert(organization_invitations).values([
      {
        organization_id: childA.id,
        email: `pending-member-${suffix}@example.com`,
        role: 'member',
        invited_by: owner.id,
        token: `pending-member-${suffix}`,
        expires_at: invitationExpiry,
      },
      {
        organization_id: childA.id,
        email: `pending-billing-${suffix}@example.com`,
        role: 'billing_manager',
        invited_by: owner.id,
        token: `pending-billing-${suffix}`,
        expires_at: invitationExpiry,
      },
      {
        organization_id: childA.id,
        email: `accepted-${suffix}@example.com`,
        role: 'member',
        invited_by: owner.id,
        token: `accepted-${suffix}`,
        expires_at: invitationExpiry,
        accepted_at: new Date().toISOString(),
      },
    ]);
  });

  afterAll(async () => {
    const organizationIds = [parent.id, childA.id, childB.id, unrelatedOrganization.id];
    const userIds = [
      owner.id,
      billingManager.id,
      organizationAdmin.id,
      member.id,
      childOwner.id,
      childMember.id,
      childBillingManager.id,
      bot.id,
      unrelatedOwner.id,
    ];
    await db
      .delete(credit_transactions)
      .where(inArray(credit_transactions.organization_id, organizationIds));
    await db
      .delete(organization_invitations)
      .where(inArray(organization_invitations.organization_id, organizationIds));
    await db
      .delete(organization_user_limits)
      .where(inArray(organization_user_limits.organization_id, organizationIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, organizationIds));
    await db.delete(organizations).where(inArray(organizations.id, [childA.id, childB.id]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [parent.id, unrelatedOrganization.id]));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  });

  it.each([
    ['owner', () => owner, true],
    ['admin', () => organizationAdmin, true],
    ['billing manager', () => billingManager, false],
  ])('returns direct child summaries to a parent %s', async (_role, getUser, canCreate) => {
    const caller = await createCallerForUser(getUser().id);

    const result = await caller.organizations.subOrganizations.overview({
      organizationId: parent.id,
    });

    expect(result.children.map(child => child.name)).toEqual(['Alpha child', 'Beta child']);
    expect(result.canCreateSubOrganizations).toBe(canCreate);
    expect(result.children[0]).toEqual({
      id: childA.id,
      name: 'Alpha child',
      plan: childA.plan,
      requireSeats: childA.require_seats,
      memberCount: 3,
      pendingInvitationCount: 2,
      seatCount: { used: 3, total: 8 },
      balanceMicrodollars: 3_750_000,
    });
    expect(result.children.some(child => child.id === unrelatedOrganization.id)).toBe(false);
  });

  it.each([
    ['parent member', () => member],
    ['child owner', () => childOwner],
  ])('rejects a %s', async (_role, getUser) => {
    const caller = await createCallerForUser(getUser().id);

    await expect(
      caller.organizations.subOrganizations.overview({ organizationId: parent.id })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('excludes soft-deleted children', async () => {
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, childB.id));

    try {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.subOrganizations.overview({
        organizationId: parent.id,
      });
      expect(result.children.map(child => child.id)).toEqual([childA.id]);
    } finally {
      await db
        .update(organizations)
        .set({ deleted_at: null })
        .where(eq(organizations.id, childB.id));
    }
  });

  it('returns an empty overview for an organization without children', async () => {
    const caller = await createCallerForUser(unrelatedOwner.id);

    await expect(
      caller.organizations.subOrganizations.overview({
        organizationId: unrelatedOrganization.id,
      })
    ).resolves.toEqual({ canCreateSubOrganizations: true, children: [] });
  });

  it('processes due credit expirations before returning a child balance', async () => {
    const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await db
      .update(organizations)
      .set({
        total_microdollars_acquired: 2_000_000,
        microdollars_used: 0,
        next_credit_expiration_at: expiredAt,
      })
      .where(eq(organizations.id, childA.id));
    await db.insert(credit_transactions).values({
      kilo_user_id: 'system',
      is_free: true,
      amount_microdollars: 2_000_000,
      description: 'Expiring sub-organization grant',
      credit_category: 'organization_custom',
      expiry_date: expiredAt,
      organization_id: childA.id,
      original_baseline_microdollars_used: 0,
      expiration_baseline_microdollars_used: 0,
    });

    try {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.subOrganizations.overview({
        organizationId: parent.id,
      });
      expect(result.children.find(child => child.id === childA.id)?.balanceMicrodollars).toBe(0);
    } finally {
      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, childA.id));
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: 5_000_000,
          microdollars_used: 1_250_000,
          next_credit_expiration_at: null,
        })
        .where(eq(organizations.id, childA.id));
    }
  });

  it('returns child members and a deduplicated cross-organization people view', async () => {
    const caller = await createCallerForUser(owner.id);

    const result = await caller.organizations.subOrganizations.people({
      organizationId: parent.id,
    });

    const alpha = result.children.find(child => child.id === childA.id);
    expect(alpha).toMatchObject({
      memberCount: 3,
      pendingInvitationCount: 2,
      roleBreakdown: { owner: 1, admin: 0, billing_manager: 1, member: 1 },
      seatCount: { used: 3, total: 8 },
    });
    expect(alpha?.owners).toEqual([
      expect.objectContaining({ kiloUserId: childOwner.id, email: childOwner.google_user_email }),
    ]);

    const sharedPerson = result.people.find(person => person.kiloUserId === childMember.id);
    expect(sharedPerson?.memberships.map(membership => membership.organizationId)).toEqual([
      childA.id,
      childB.id,
    ]);
    expect(sharedPerson?.statuses).toEqual(['accepted']);
    expect(result.people.find(person => person.kiloUserId === owner.id)).toMatchObject({
      parentMembership: { role: 'owner', status: 'accepted' },
      memberships: [],
    });
    expect(result.people.find(person => person.kiloUserId === organizationAdmin.id)).toMatchObject({
      parentMembership: { role: 'admin', status: 'accepted' },
      memberships: [],
    });
    expect(result.people.find(person => person.email.startsWith('pending-member-'))).toMatchObject({
      kiloUserId: null,
      parentMembership: null,
      statuses: ['pending'],
      invitations: [
        expect.objectContaining({
          organizationId: childA.id,
          role: 'member',
          status: 'pending',
        }),
      ],
    });
    expect(result.pageInfo).toMatchObject({ page: 1, pageSize: 25, total: 10, pageCount: 1 });
    expect(result.people.some(person => person.kiloUserId === bot.id)).toBe(false);
  });

  it('searches, filters, and orders aggregate people on the server', async () => {
    const caller = await createCallerForUser(owner.id);

    const searched = await caller.organizations.subOrganizations.people({
      organizationId: parent.id,
      search: childMember.google_user_email,
    });
    expect(searched.people).toHaveLength(1);
    expect(searched.people[0]?.kiloUserId).toBe(childMember.id);

    const unassigned = await caller.organizations.subOrganizations.people({
      organizationId: parent.id,
      assignment: 'unassigned',
      status: 'accepted',
      sortBy: 'parentRole',
      sortDirection: 'asc',
    });
    expect(unassigned.people.map(person => person.kiloUserId)).toEqual(
      expect.arrayContaining([owner.id, organizationAdmin.id, billingManager.id, member.id])
    );
    expect(unassigned.people.every(person => person.memberships.length === 0)).toBe(true);

    const admins = await caller.organizations.subOrganizations.people({
      organizationId: parent.id,
      role: 'admin',
    });
    expect(admins.people.map(person => person.kiloUserId)).toEqual([organizationAdmin.id]);

    const childMembers = await caller.organizations.subOrganizations.people({
      organizationId: parent.id,
      subOrganizationId: childB.id,
      role: 'member',
    });
    expect(childMembers.people.map(person => person.kiloUserId)).toEqual([childMember.id]);
  });

  it('rejects a sub-organization as the management root', async () => {
    const caller = await createCallerForUser(childOwner.id);

    await expect(
      caller.organizations.subOrganizations.overview({ organizationId: childA.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns detailed credit state after expiry processing', async () => {
    const caller = await createCallerForUser(owner.id);

    const result = await caller.organizations.subOrganizations.credits({
      organizationId: parent.id,
    });

    expect(result.kiloPassStatus).toBe('available');
    expect(result.children.find(child => child.id === childA.id)).toMatchObject({
      totalMicrodollarsAcquired: 5_000_000,
      microdollarsUsed: 1_250_000,
      balanceMicrodollars: 3_750_000,
      autoTopUpEnabled: false,
      seatCount: { used: 3, total: 8 },
      minimumBalanceMicrodollars: 4_000_000,
      kiloPassAllocation: null,
    });
  });

  it('does not return a stale next expiration after processing the final expiring grant', async () => {
    const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await db
      .update(organizations)
      .set({
        total_microdollars_acquired: 2_000_000,
        microdollars_used: 0,
        next_credit_expiration_at: expiredAt,
      })
      .where(eq(organizations.id, childA.id));
    await db.insert(credit_transactions).values({
      kilo_user_id: 'system',
      is_free: true,
      amount_microdollars: 2_000_000,
      description: 'Final expiring sub-organization grant',
      credit_category: 'organization_custom',
      expiry_date: expiredAt,
      organization_id: childA.id,
      original_baseline_microdollars_used: 0,
      expiration_baseline_microdollars_used: 0,
    });

    try {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.subOrganizations.credits({
        organizationId: parent.id,
      });

      expect(
        result.children.find(child => child.id === childA.id)?.nextCreditExpirationAt
      ).toBeNull();
    } finally {
      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, childA.id));
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: 5_000_000,
          microdollars_used: 1_250_000,
          next_credit_expiration_at: null,
        })
        .where(eq(organizations.id, childA.id));
    }
  });

  it('returns a pending Kilo Pass child allocation', async () => {
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 3,
      issuanceAnchorAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: childA.id, passCapacity: 1 }],
    });

    try {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.subOrganizations.credits({
        organizationId: parent.id,
      });

      expect(
        result.children.find(child => child.id === childA.id)?.kiloPassAllocation
      ).toMatchObject({
        currentPassCount: 0,
        nextPassCount: 1,
        planVersion: 1,
      });
    } finally {
      await db
        .delete(kilo_pass_org_agreements)
        .where(eq(kilo_pass_org_agreements.id, pending.agreementId));
    }
  });

  it('shows stored Teams model restrictions as inactive', async () => {
    const caller = await createCallerForUser(owner.id);

    const result = await caller.organizations.subOrganizations.modelPolicy({
      organizationId: parent.id,
    });

    const alpha = result.children.find(child => child.id === childA.id);
    expect(alpha?.organizationRestrictions).toEqual({
      enforcement: 'inactive_plan',
      configured: {
        providerAllowList: ['openai'],
        modelDenyList: ['test/denied'],
      },
      effective: { providerAllowList: null, modelDenyList: [] },
    });
    expect(alpha?.dataCollection).toBe('deny');
  });

  it('separates inherited parent access from child roles and limits', async () => {
    const caller = await createCallerForUser(owner.id);

    const result = await caller.organizations.subOrganizations.permissions({
      organizationId: parent.id,
    });

    expect(result.inheritedAccess.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kiloUserId: owner.id, parentRole: 'owner' }),
        expect.objectContaining({ kiloUserId: organizationAdmin.id, parentRole: 'admin' }),
        expect.objectContaining({
          kiloUserId: billingManager.id,
          parentRole: 'billing_manager',
        }),
      ])
    );
    expect(result.inheritedAccess.users.some(user => user.kiloUserId === member.id)).toBe(false);
    const alpha = result.children.find(child => child.id === childA.id);
    expect(alpha).toMatchObject({
      roleBreakdown: { owner: 1, admin: 0, billing_manager: 1, member: 1 },
      hasIndependentOwner: true,
      effectiveSsoPolicy: { status: 'not_required' },
      featureSettings: {
        enableUsageLimits: true,
        projectsUiEnabled: true,
        dataCollection: 'deny',
      },
    });
    expect(alpha?.dailyUserLimits).toEqual([
      expect.objectContaining({
        kiloUserId: childMember.id,
        limitMicrodollars: 1_500_000,
        enforcedForRole: true,
      }),
    ]);
  });

  it.each([
    ['parent member', () => member],
    ['child owner', () => childOwner],
  ])('rejects a %s from every detail procedure', async (_role, getUser) => {
    const caller = await createCallerForUser(getUser().id);

    for (const procedure of ['people', 'credits', 'modelPolicy', 'permissions'] as const) {
      await expect(
        caller.organizations.subOrganizations[procedure]({ organizationId: parent.id })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it.each(['people', 'credits', 'modelPolicy', 'permissions'] as const)(
    'uses a fixed number of selects for %s',
    async procedure => {
      const caller = await createCallerForUser(owner.id);
      const selectSpy = jest.spyOn(db, 'select');

      try {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(eq(organizations.id, childB.id));
        selectSpy.mockClear();
        await caller.organizations.subOrganizations[procedure]({ organizationId: parent.id });
        const oneChildSelectCount = selectSpy.mock.calls.length;

        await db
          .update(organizations)
          .set({ parent_organization_id: parent.id })
          .where(eq(organizations.id, childB.id));
        selectSpy.mockClear();
        await caller.organizations.subOrganizations[procedure]({ organizationId: parent.id });

        expect(selectSpy.mock.calls.length).toBe(oneChildSelectCount);
      } finally {
        selectSpy.mockRestore();
        await db
          .update(organizations)
          .set({ parent_organization_id: parent.id })
          .where(eq(organizations.id, childB.id));
      }
    }
  );

  it('uses a fixed number of selects for one or many children', async () => {
    const caller = await createCallerForUser(owner.id);
    const selectSpy = jest.spyOn(db, 'select');

    try {
      await db
        .update(organizations)
        .set({ parent_organization_id: null })
        .where(eq(organizations.id, childB.id));
      selectSpy.mockClear();
      await caller.organizations.subOrganizations.overview({ organizationId: parent.id });
      const oneChildSelectCount = selectSpy.mock.calls.length;

      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, childB.id));
      selectSpy.mockClear();
      await caller.organizations.subOrganizations.overview({ organizationId: parent.id });
      const twoChildSelectCount = selectSpy.mock.calls.length;

      expect(twoChildSelectCount).toBe(oneChildSelectCount);
    } finally {
      selectSpy.mockRestore();
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, childB.id));
    }
  });
});
