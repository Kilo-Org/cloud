import { afterEach, describe, expect, it } from '@jest/globals';
import {
  kilocode_users,
  organization_audit_logs,
  organization_domain_claims,
  organization_invitations,
  organization_membership_removals,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  acceptOrganizationInvite,
  addUserToOrganization,
  createOrganization,
  removeUserFromOrganization,
} from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { ensureVerifiedDomainOrganizationMembership } from './verified-domain-membership';

describe('verified-domain automatic membership', () => {
  const organizationIds: string[] = [];
  const userIds: string[] = [];

  async function createUser(values: Partial<User> = {}): Promise<User> {
    const user = await insertTestUser(values);
    userIds.push(user.id);
    return user;
  }

  async function createVerifiedOrganization(domain: string) {
    const owner = await createUser();
    const organization = await createOrganization(
      `Verified domain ${crypto.randomUUID()}`,
      owner.id
    );
    organizationIds.push(organization.id);
    await db.insert(organization_domain_claims).values({
      organization_id: organization.id,
      domain,
      status: 'verified',
      workos_organization_id: `workos-org-${crypto.randomUUID()}`,
      workos_domain_id: `workos-domain-${crypto.randomUUID()}`,
      verified_at: new Date().toISOString(),
    });
    return { organization, owner };
  }

  async function membershipsFor(userId: string) {
    return db
      .select({
        organizationId: organization_memberships.organization_id,
        role: organization_memberships.role,
      })
      .from(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));
  }

  async function autoJoinAudits() {
    if (organizationIds.length === 0) return [];
    return db
      .select()
      .from(organization_audit_logs)
      .where(
        and(
          inArray(organization_audit_logs.organization_id, organizationIds),
          eq(organization_audit_logs.action, 'organization.member.auto_join')
        )
      );
  }

  afterEach(async () => {
    if (organizationIds.length > 0) {
      await db
        .delete(organization_audit_logs)
        .where(inArray(organization_audit_logs.organization_id, organizationIds));
      await db
        .delete(organization_invitations)
        .where(inArray(organization_invitations.organization_id, organizationIds));
      await db
        .delete(organization_membership_removals)
        .where(inArray(organization_membership_removals.organization_id, organizationIds));
      await db
        .delete(organization_memberships)
        .where(inArray(organization_memberships.organization_id, organizationIds));
      await db
        .delete(organization_domain_claims)
        .where(inArray(organization_domain_claims.organization_id, organizationIds));
      await db.delete(organizations).where(inArray(organizations.id, organizationIds));
    }
    if (userIds.length > 0) {
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
    }
    organizationIds.length = 0;
    userIds.length = 0;
  });

  it('matches a canonical exact domain but not its subdomains', async () => {
    const { organization } = await createVerifiedOrganization('example.com');
    const exact = await createUser({ google_user_email: 'Person@Example.COM' });
    const subdomain = await createUser({ google_user_email: 'person@team.example.com' });

    await expect(ensureVerifiedDomainOrganizationMembership(exact.id)).resolves.toEqual({
      organizationId: organization.id,
      membershipCreated: true,
    });
    await expect(ensureVerifiedDomainOrganizationMembership(subdomain.id)).resolves.toBeNull();
    expect(await membershipsFor(exact.id)).toEqual([
      { organizationId: organization.id, role: 'member' },
    ]);
    expect(await membershipsFor(subdomain.id)).toEqual([]);
  });

  it('creates an ordinary member and one creation audit', async () => {
    const { organization } = await createVerifiedOrganization('ordinary.example.com');
    const user = await createUser({ google_user_email: 'human@ordinary.example.com' });

    await ensureVerifiedDomainOrganizationMembership(user.id);

    expect(await membershipsFor(user.id)).toEqual([
      { organizationId: organization.id, role: 'member' },
    ]);
    expect(await autoJoinAudits()).toEqual([
      expect.objectContaining({
        action: 'organization.member.auto_join',
        actor_email: user.google_user_email,
        actor_id: user.id,
        actor_name: user.google_user_name,
        message: 'User joined organization via verified domain',
        organization_id: organization.id,
      }),
    ]);
  });

  it('preserves an existing role and is idempotent without duplicate audits', async () => {
    const { organization } = await createVerifiedOrganization('existing.example.com');
    const user = await createUser({ google_user_email: 'admin@existing.example.com' });
    await addUserToOrganization(organization.id, user.id, 'admin');

    await expect(ensureVerifiedDomainOrganizationMembership(user.id)).resolves.toEqual({
      organizationId: organization.id,
      membershipCreated: false,
    });
    await expect(ensureVerifiedDomainOrganizationMembership(user.id)).resolves.toEqual({
      organizationId: organization.id,
      membershipCreated: false,
    });

    expect(await membershipsFor(user.id)).toEqual([
      { organizationId: organization.id, role: 'admin' },
    ]);
    expect(await autoJoinAudits()).toEqual([]);
  });

  it('skips bot users without side effects', async () => {
    await createVerifiedOrganization('bots.example.com');
    const bot = await createUser({ google_user_email: 'bot@bots.example.com', is_bot: true });

    await expect(ensureVerifiedDomainOrganizationMembership(bot.id)).resolves.toBeNull();
    expect(await membershipsFor(bot.id)).toEqual([]);
    expect(await autoJoinAudits()).toEqual([]);
  });

  it.each([
    'missing-at.example.com',
    '@malformed.example.com',
    'user@@malformed.example.com',
    'bad local@malformed.example.com',
    'user@',
  ])('skips malformed primary email %s without side effects', async email => {
    await createVerifiedOrganization('malformed.example.com');
    const user = await createUser({ google_user_email: email });

    await expect(ensureVerifiedDomainOrganizationMembership(user.id)).resolves.toBeNull();
    expect(await membershipsFor(user.id)).toEqual([]);
    expect(await autoJoinAudits()).toEqual([]);
  });

  it('honors a membership removal tombstone without repeated denial audits', async () => {
    const { organization } = await createVerifiedOrganization('removed.example.com');
    const user = await createUser({ google_user_email: 'removed@removed.example.com' });
    await db.insert(organization_membership_removals).values({
      organization_id: organization.id,
      kilo_user_id: user.id,
      previous_role: 'member',
    });

    await expect(ensureVerifiedDomainOrganizationMembership(user.id)).resolves.toBeNull();
    await expect(ensureVerifiedDomainOrganizationMembership(user.id)).resolves.toBeNull();
    expect(await membershipsFor(user.id)).toEqual([]);
    expect(await autoJoinAudits()).toEqual([]);
  });

  it('accepts a matching pending invitation without inheriting its elevated role', async () => {
    const { organization, owner } = await createVerifiedOrganization('invited.example.com');
    const user = await createUser({ google_user_email: 'invitee@invited.example.com' });
    const [invitation] = await db
      .insert(organization_invitations)
      .values({
        organization_id: organization.id,
        email: 'Invitee+pending@INVITED.EXAMPLE.COM',
        role: 'owner',
        invited_by: owner.id,
        token: crypto.randomUUID(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .returning();

    await ensureVerifiedDomainOrganizationMembership(user.id);

    expect(await membershipsFor(user.id)).toEqual([
      { organizationId: organization.id, role: 'member' },
    ]);
    const reconciled = await db.query.organization_invitations.findFirst({
      where: eq(organization_invitations.id, invitation.id),
    });
    expect(reconciled?.accepted_at).not.toBeNull();
  });

  it('preserves personal state and unrelated organization memberships', async () => {
    const { organization } = await createVerifiedOrganization('preserve.example.com');
    const unrelatedOwner = await createUser();
    const unrelated = await createOrganization(
      `Unrelated ${crypto.randomUUID()}`,
      unrelatedOwner.id
    );
    organizationIds.push(unrelated.id);
    const user = await createUser({
      google_user_email: 'person@preserve.example.com',
      personal_account_disabled: true,
      customer_source: 'recommendation',
      microdollars_used: 1234,
      total_microdollars_acquired: 5678,
      api_token_pepper: 'preserved-api-pepper',
      web_session_pepper: 'preserved-session-pepper',
    });
    await addUserToOrganization(unrelated.id, user.id, 'billing_manager');
    const before = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });

    await ensureVerifiedDomainOrganizationMembership(user.id);

    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after).toEqual(before);
    expect(await membershipsFor(user.id)).toEqual(
      expect.arrayContaining([
        { organizationId: organization.id, role: 'member' },
        { organizationId: unrelated.id, role: 'billing_manager' },
      ])
    );
  });

  it('serializes concurrent admissions to one membership and one audit', async () => {
    const { organization } = await createVerifiedOrganization('concurrent.example.com');
    const user = await createUser({ google_user_email: 'person@concurrent.example.com' });

    const results = await Promise.all([
      ensureVerifiedDomainOrganizationMembership(user.id),
      ensureVerifiedDomainOrganizationMembership(user.id),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        { organizationId: organization.id, membershipCreated: true },
        { organizationId: organization.id, membershipCreated: false },
      ])
    );
    expect(await membershipsFor(user.id)).toEqual([
      { organizationId: organization.id, role: 'member' },
    ]);
    expect(await autoJoinAudits()).toHaveLength(1);
  });

  it('uses authoritative local user state', async () => {
    const { organization } = await createVerifiedOrganization('authoritative.example.com');
    const user = await createUser({ google_user_email: 'person@other.example.com' });
    await db
      .update(kilocode_users)
      .set({
        google_user_email: 'person@authoritative.example.com',
        normalized_email: 'person@authoritative.example.com',
      })
      .where(eq(kilocode_users.id, user.id));

    await expect(ensureVerifiedDomainOrganizationMembership(user.id)).resolves.toEqual({
      organizationId: organization.id,
      membershipCreated: true,
    });
  });

  it('fails safely when stored email normalization is inconsistent', async () => {
    await createVerifiedOrganization('normalized.example.com');
    const user = await createUser({
      google_user_email: 'person@other.example.com',
      normalized_email: 'person@normalized.example.com',
    });

    await expect(ensureVerifiedDomainOrganizationMembership(user.id)).resolves.toBeNull();
    expect(await membershipsFor(user.id)).toEqual([]);
  });

  it('does not join a deleted organization', async () => {
    const { organization } = await createVerifiedOrganization('deleted.example.com');
    const user = await createUser({ google_user_email: 'person@deleted.example.com' });
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));

    await expect(ensureVerifiedDomainOrganizationMembership(user.id)).resolves.toBeNull();
    expect(await membershipsFor(user.id)).toEqual([]);
  });

  it('converges with concurrent explicit removal to a tombstone and no membership', async () => {
    const { organization } = await createVerifiedOrganization('removal-race.example.com');
    const user = await createUser({ google_user_email: 'person@removal-race.example.com' });
    await addUserToOrganization(organization.id, user.id, 'member');

    await Promise.all([
      ensureVerifiedDomainOrganizationMembership(user.id),
      removeUserFromOrganization(organization.id, user.id),
    ]);

    expect(await membershipsFor(user.id)).toEqual([]);
    await expect(
      db.query.organization_membership_removals.findFirst({
        where: and(
          eq(organization_membership_removals.organization_id, organization.id),
          eq(organization_membership_removals.kilo_user_id, user.id)
        ),
      })
    ).resolves.toBeDefined();
  });

  it('does not deadlock with concurrent explicit invitation acceptance', async () => {
    const { organization, owner } = await createVerifiedOrganization('invite-race.example.com');
    const user = await createUser({ google_user_email: 'person@invite-race.example.com' });
    const [invitation] = await db
      .insert(organization_invitations)
      .values({
        organization_id: organization.id,
        email: user.google_user_email,
        role: 'owner',
        invited_by: owner.id,
        token: crypto.randomUUID(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .returning();

    await Promise.all([
      ensureVerifiedDomainOrganizationMembership(user.id),
      acceptOrganizationInvite(user.id, invitation.token),
    ]);

    const memberships = await membershipsFor(user.id);
    expect(memberships).toHaveLength(1);
    expect(['member', 'owner']).toContain(memberships[0].role);
  });
});
