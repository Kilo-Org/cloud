import { beforeEach, describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
  user_auth_provider,
  type User,
} from '@kilocode/db/schema';
import type { OrganizationRole } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { Owner } from '@/lib/integrations/core/types';
import { authorizeDiscordSessionRequester } from './discord-session-authorization';

let discordAccountSequence = 0;

function nextDiscordUserId(): string {
  discordAccountSequence += 1;
  return `${Date.now()}${String(discordAccountSequence).padStart(6, '0')}`;
}

async function linkDiscordAccount(kiloUserId: string, discordUserId: string): Promise<void> {
  await db.insert(user_auth_provider).values({
    kilo_user_id: kiloUserId,
    provider: 'discord',
    provider_account_id: discordUserId,
    email: `${discordUserId}@example.com`,
    avatar_url: 'https://example.com/avatar.png',
  });
}

async function addMembership(
  organizationId: string,
  kiloUserId: string,
  role: OrganizationRole
): Promise<void> {
  await db.insert(organization_memberships).values({
    organization_id: organizationId,
    kilo_user_id: kiloUserId,
    role,
  });
}

async function createUserOwnedInstallation(ownerId: string): Promise<Owner> {
  await db.insert(platform_integrations).values({
    owned_by_user_id: ownerId,
    platform: 'discord',
    integration_type: 'oauth',
    platform_installation_id: nextDiscordUserId(),
    integration_status: 'active',
  });
  return { type: 'user', id: ownerId };
}

describe('authorizeDiscordSessionRequester', () => {
  let installationOwner: User;

  beforeEach(async () => {
    installationOwner = await insertTestUser();
  });

  it('allows the linked Kilo user who owns a user-owned installation', async () => {
    const discordUserId = nextDiscordUserId();
    await linkDiscordAccount(installationOwner.id, discordUserId);
    const owner = await createUserOwnedInstallation(installationOwner.id);

    await expect(authorizeDiscordSessionRequester(owner, discordUserId)).resolves.toEqual({
      authorized: true,
      discordUserId,
      kiloUserId: installationOwner.id,
    });
  });

  it('denies a linked Kilo user who does not own the installation', async () => {
    const discordUserId = nextDiscordUserId();
    const otherUser = await insertTestUser();
    await linkDiscordAccount(otherUser.id, discordUserId);
    const owner = await createUserOwnedInstallation(installationOwner.id);

    await expect(authorizeDiscordSessionRequester(owner, discordUserId)).resolves.toEqual({
      authorized: false,
      discordUserId,
      reason: 'not_installation_owner',
    });
  });

  it('denies a Discord author with no linked Kilo account', async () => {
    const owner = await createUserOwnedInstallation(installationOwner.id);

    await expect(
      authorizeDiscordSessionRequester(owner, nextDiscordUserId())
    ).resolves.toMatchObject({ authorized: false, reason: 'unlinked_account' });
  });

  it('denies a missing Discord author id', async () => {
    const owner = await createUserOwnedInstallation(installationOwner.id);

    await expect(authorizeDiscordSessionRequester(owner, undefined)).resolves.toEqual({
      authorized: false,
      reason: 'unknown_requester',
    });
  });

  it('denies a linked Kilo account that is blocked', async () => {
    const discordUserId = nextDiscordUserId();
    const blockedUser = await insertTestUser({ blocked_at: new Date().toISOString() });
    await linkDiscordAccount(blockedUser.id, discordUserId);
    const owner = await createUserOwnedInstallation(blockedUser.id);

    await expect(authorizeDiscordSessionRequester(owner, discordUserId)).resolves.toEqual({
      authorized: false,
      discordUserId,
      reason: 'account_unavailable',
    });
  });

  it('denies a linked Kilo account whose personal account is disabled', async () => {
    const discordUserId = nextDiscordUserId();
    const disabledUser = await insertTestUser({ personal_account_disabled: true });
    await linkDiscordAccount(disabledUser.id, discordUserId);
    const owner = await createUserOwnedInstallation(disabledUser.id);

    await expect(authorizeDiscordSessionRequester(owner, discordUserId)).resolves.toEqual({
      authorized: false,
      discordUserId,
      reason: 'account_unavailable',
    });
  });

  it('allows a linked organization member', async () => {
    const discordUserId = nextDiscordUserId();
    const member = await insertTestUser();
    await linkDiscordAccount(member.id, discordUserId);
    const organization = await createTestOrganization('Session members', installationOwner.id, 0);
    await addMembership(organization.id, member.id, 'member');

    await expect(
      authorizeDiscordSessionRequester({ type: 'org', id: organization.id }, discordUserId)
    ).resolves.toEqual({ authorized: true, discordUserId, kiloUserId: member.id });
  });

  it('denies an organization billing manager', async () => {
    const discordUserId = nextDiscordUserId();
    const billingManager = await insertTestUser();
    await linkDiscordAccount(billingManager.id, discordUserId);
    const organization = await createTestOrganization('Session billing', installationOwner.id, 0);
    await addMembership(organization.id, billingManager.id, 'billing_manager');

    await expect(
      authorizeDiscordSessionRequester({ type: 'org', id: organization.id }, discordUserId)
    ).resolves.toMatchObject({ authorized: false, reason: 'not_organization_member' });
  });

  it('denies a linked Kilo user outside the organization', async () => {
    const discordUserId = nextDiscordUserId();
    const outsider = await insertTestUser();
    await linkDiscordAccount(outsider.id, discordUserId);
    const organization = await createTestOrganization('Session outsiders', installationOwner.id, 0);

    await expect(
      authorizeDiscordSessionRequester({ type: 'org', id: organization.id }, discordUserId)
    ).resolves.toMatchObject({ authorized: false, reason: 'not_organization_member' });
  });

  it('allows a parent-organization admin to use a child-organization installation', async () => {
    const discordUserId = nextDiscordUserId();
    const parentAdmin = await insertTestUser();
    await linkDiscordAccount(parentAdmin.id, discordUserId);
    const parent = await createTestOrganization('Session parent', installationOwner.id, 0);
    const child = await createTestOrganization('Session child', installationOwner.id, 0);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    await addMembership(parent.id, parentAdmin.id, 'admin');

    await expect(
      authorizeDiscordSessionRequester({ type: 'org', id: child.id }, discordUserId)
    ).resolves.toEqual({ authorized: true, discordUserId, kiloUserId: parentAdmin.id });
  });

  it('denies a parent-organization member role on a child-organization installation', async () => {
    const discordUserId = nextDiscordUserId();
    const parentMember = await insertTestUser();
    await linkDiscordAccount(parentMember.id, discordUserId);
    const parent = await createTestOrganization('Session parent members', installationOwner.id, 0);
    const child = await createTestOrganization('Session child members', installationOwner.id, 0);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    await addMembership(parent.id, parentMember.id, 'member');

    await expect(
      authorizeDiscordSessionRequester({ type: 'org', id: child.id }, discordUserId)
    ).resolves.toMatchObject({ authorized: false, reason: 'not_organization_member' });
  });

  it('denies organization installations whose organization was deleted', async () => {
    const discordUserId = nextDiscordUserId();
    const member = await insertTestUser();
    await linkDiscordAccount(member.id, discordUserId);
    const organization = await createTestOrganization('Session deleted', installationOwner.id, 0);
    await addMembership(organization.id, member.id, 'owner');
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));

    await expect(
      authorizeDiscordSessionRequester({ type: 'org', id: organization.id }, discordUserId)
    ).resolves.toMatchObject({ authorized: false, reason: 'not_organization_member' });
  });

  it('denies a Kilo account whose user row no longer exists', async () => {
    const discordUserId = nextDiscordUserId();
    const removedUser = await insertTestUser();
    await linkDiscordAccount(removedUser.id, discordUserId);
    await db.delete(kilocode_users).where(eq(kilocode_users.id, removedUser.id));
    const owner = await createUserOwnedInstallation(installationOwner.id);

    await expect(authorizeDiscordSessionRequester(owner, discordUserId)).resolves.toEqual({
      authorized: false,
      discordUserId,
      reason: 'unlinked_account',
    });
  });
});
