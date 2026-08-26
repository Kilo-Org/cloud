import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import {
  addUserToOrganization,
  createOrganization,
  getProfileOrganizations,
} from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kilocode_users,
  organization_domain_claims,
  organization_membership_removals,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { resolvePreferredVerifiedDomainOrganizationId } from './verified-domain-destination';

describe('verified-domain organization destination', () => {
  const organizationIds: string[] = [];
  const userIds: string[] = [];

  async function createUser(values: Partial<User> = {}) {
    const user = await insertTestUser(values);
    userIds.push(user.id);
    return user;
  }

  async function createTrackedOrganization(name: string, ownerId: string) {
    const organization = await createOrganization(name, ownerId);
    organizationIds.push(organization.id);
    return organization;
  }

  async function createVerifiedOrganization(domain: string) {
    const owner = await createUser();
    const organization = await createTrackedOrganization(`Verified ${domain}`, owner.id);
    await db.insert(organization_domain_claims).values({
      organization_id: organization.id,
      domain,
      status: 'verified',
      workos_organization_id: `workos-org-${crypto.randomUUID()}`,
      workos_domain_id: `workos-domain-${crypto.randomUUID()}`,
      verified_at: new Date().toISOString(),
    });
    return organization;
  }

  async function resolveFor(user: User) {
    const permittedOrganizations = await getProfileOrganizations(user.id, {
      excludeAccessBlocked: true,
    });
    return resolvePreferredVerifiedDomainOrganizationId(user, permittedOrganizations);
  }

  afterEach(async () => {
    if (organizationIds.length > 0) {
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

  it('prefers the exact verified-domain organization over unrelated memberships', async () => {
    const verified = await createVerifiedOrganization('preferred.example.com');
    const user = await createUser({ google_user_email: 'Person@Preferred.Example.COM' });
    const unrelatedOwner = await createUser();
    const unrelated = await createTrackedOrganization('Unrelated', unrelatedOwner.id);
    await addUserToOrganization(unrelated.id, user.id, 'admin');
    await addUserToOrganization(verified.id, user.id, 'member');

    await expect(resolveFor(user)).resolves.toBe(verified.id);
  });

  it('does not infer membership or auto-join a matching user', async () => {
    const verified = await createVerifiedOrganization('no-membership.example.com');
    const user = await createUser({ google_user_email: 'person@no-membership.example.com' });

    await expect(resolveFor(user)).resolves.toBeNull();
    await expect(
      db.query.organization_memberships.findFirst({
        where: eq(organization_memberships.kilo_user_id, user.id),
      })
    ).resolves.toBeUndefined();
    await expect(
      db.query.organization_domain_claims.findFirst({
        where: eq(organization_domain_claims.organization_id, verified.id),
      })
    ).resolves.toBeDefined();
  });

  it('does not bypass a removal tombstone to imply auto-join', async () => {
    const verified = await createVerifiedOrganization('removed.example.com');
    const user = await createUser({ google_user_email: 'person@removed.example.com' });
    await db.insert(organization_membership_removals).values({
      organization_id: verified.id,
      kilo_user_id: user.id,
      previous_role: 'member',
    });

    await expect(resolveFor(user)).resolves.toBeNull();
  });

  it('rejects deleted and access-blocked verified-domain organizations', async () => {
    const deleted = await createVerifiedOrganization('deleted-destination.example.com');
    const blocked = await createVerifiedOrganization('blocked-destination.example.com');
    const deletedUser = await createUser({
      google_user_email: 'person@deleted-destination.example.com',
    });
    const blockedUser = await createUser({
      google_user_email: 'person@blocked-destination.example.com',
    });
    await addUserToOrganization(deleted.id, deletedUser.id, 'member');
    await addUserToOrganization(blocked.id, blockedUser.id, 'member');
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, deleted.id));
    await db
      .update(organizations)
      .set({ free_trial_end_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(organizations.id, blocked.id));

    await expect(resolveFor(deletedUser)).resolves.toBeNull();
    await expect(resolveFor(blockedUser)).resolves.toBeNull();
  });

  it('fails safely when the stored email identity is stale or malformed', async () => {
    const verified = await createVerifiedOrganization('stale.example.com');
    const stale = await createUser({
      google_user_email: 'person@stale.example.com',
      normalized_email: 'person@old.example.com',
    });
    const malformed = await createUser({ google_user_email: 'person@@stale.example.com' });
    await addUserToOrganization(verified.id, stale.id, 'member');
    await addUserToOrganization(verified.id, malformed.id, 'member');

    await expect(resolveFor(stale)).resolves.toBeNull();
    await expect(resolveFor(malformed)).resolves.toBeNull();
  });

  it('returns no preference for pending or unrelated verified domains', async () => {
    const owner = await createUser();
    const pending = await createTrackedOrganization('Pending', owner.id);
    await db.insert(organization_domain_claims).values({
      organization_id: pending.id,
      domain: 'pending.example.com',
      status: 'pending',
    });
    const user = await createUser({ google_user_email: 'person@pending.example.com' });
    await addUserToOrganization(pending.id, user.id, 'member');

    await expect(resolveFor(user)).resolves.toBeNull();
  });
});
