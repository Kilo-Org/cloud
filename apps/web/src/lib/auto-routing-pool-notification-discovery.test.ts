import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';
import {
  auto_routing_custom_routers,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { sendAutoRoutingPoolNoticeEmail } from '@kilocode/web-shared/lib/auto-routing-pool-notice-email';
import { sendViaMailgun } from '@kilocode/web-shared/lib/email-mailgun';
import { discoverPoolNotificationOwners } from '../scripts/lib/auto-routing-pool-notification-discovery';
import {
  buildPoolNotificationTargets,
  runPoolNotifications,
} from '../scripts/lib/auto-routing-pool-notifications';
import {
  createDeletionInProgressBlockedReason,
  createSoftDeletedBlockedReason,
} from '@kilocode/db/user-soft-delete';

const captureMail = jest.mocked(sendViaMailgun);
jest.mock('@kilocode/web-shared/lib/email-mailgun', () => ({
  getEmailVerificationRecipient: (to: string) => to,
  sendViaMailgun: jest.fn(async () => true),
}));
jest.mock('@kilocode/web-shared/lib/email-neverbounce', () => ({
  verifyEmail: jest.fn(async () => true),
}));

const userIds: string[] = [];
const organizationIds: string[] = [];
const routerIds: string[] = [];
let stateDir: string | undefined;

async function seedUser(values: Partial<User> = {}) {
  const user = await insertTestUser(values);
  userIds.push(user.id);
  return user;
}

async function seedOrganization(name: string, deleted = false, parentOrganizationId?: string) {
  const [organization] = await db
    .insert(organizations)
    .values({
      name,
      deleted_at: deleted ? new Date().toISOString() : null,
      parent_organization_id: parentOrganizationId ?? null,
    })
    .returning();
  organizationIds.push(organization.id);
  return organization;
}

async function seedRouter(
  owner: { userId: string } | { organizationId: string },
  legacyPool = true
) {
  const [router] = await db
    .insert(auto_routing_custom_routers)
    .values({
      ...('userId' in owner
        ? { owned_by_user_id: owner.userId }
        : { owned_by_organization_id: owner.organizationId }),
      legacy_pool: legacyPool,
      slug: legacyPool ? 'efficient' : 'another-router',
      name: 'Fixture pool',
      base_router: 'efficient',
      mode: 'cost_per_accuracy',
      entries: [],
      default_entry_key: 'fixture',
    })
    .returning();
  routerIds.push(router.id);
  return router;
}

afterEach(async () => {
  if (routerIds.length)
    await db
      .delete(auto_routing_custom_routers)
      .where(inArray(auto_routing_custom_routers.id, routerIds.splice(0)));
  if (organizationIds.length) {
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, organizationIds));
    await db.delete(organizations).where(inArray(organizations.id, organizationIds.splice(0)));
  }
  if (userIds.length)
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds.splice(0)));
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
  stateDir = undefined;
  captureMail.mockClear();
});

describe('migrated pool discovery and capture', () => {
  it('discovers only marked live owners and current billing roles, then sends one captured notice per recipient with all routers', async () => {
    const owner = await seedUser();
    const admin = await seedUser();
    const billing = await seedUser();
    const member = await seedUser();
    const bot = await seedUser({ is_bot: true });
    const organization = await seedOrganization('Fixture first organization');
    const secondOrganization = await seedOrganization('Fixture second organization');
    const deletedOrganization = await seedOrganization('Fixture deleted organization', true);
    const personal = await seedRouter({ userId: owner.id });
    const unmarked = await seedRouter({ userId: owner.id }, false);
    const orgRouter = await seedRouter({ organizationId: organization.id });
    const secondOrgRouter = await seedRouter({ organizationId: secondOrganization.id });
    const deletedOrgRouter = await seedRouter({ organizationId: deletedOrganization.id });
    await db.insert(organization_memberships).values([
      { organization_id: organization.id, kilo_user_id: owner.id, role: 'owner' },
      { organization_id: organization.id, kilo_user_id: admin.id, role: 'admin' },
      { organization_id: organization.id, kilo_user_id: billing.id, role: 'billing_manager' },
      { organization_id: organization.id, kilo_user_id: member.id, role: 'member' },
      { organization_id: organization.id, kilo_user_id: bot.id, role: 'owner' },
      { organization_id: secondOrganization.id, kilo_user_id: owner.id, role: 'owner' },
      { organization_id: deletedOrganization.id, kilo_user_id: owner.id, role: 'owner' },
    ]);

    const owners = await discoverPoolNotificationOwners(db);
    const { targets } = buildPoolNotificationTargets(owners);
    const discoveredIds = owners.flatMap(item => item.routers.map(router => router.id));
    expect(discoveredIds).toEqual(
      expect.arrayContaining([personal.id, orgRouter.id, secondOrgRouter.id])
    );
    expect(discoveredIds).not.toEqual(expect.arrayContaining([unmarked.id]));
    expect(discoveredIds).not.toEqual(expect.arrayContaining([deletedOrgRouter.id]));
    expect(targets.map(target => target.to).sort()).toEqual(
      [owner.google_user_email, admin.google_user_email, billing.google_user_email].sort()
    );
    expect(
      targets
        .find(target => target.to === owner.google_user_email)
        ?.routers.map(router => router.modelId)
        .sort()
    ).toEqual([
      'kilo-auto/custom/efficient',
      'kilo-auto/custom/org/efficient',
      'kilo-auto/custom/org/efficient',
    ]);

    stateDir = await mkdtemp(join(tmpdir(), 'pool-discovery-capture-'));
    const sendEmail = (target: (typeof targets)[number], cutoverAt: string) =>
      sendAutoRoutingPoolNoticeEmail({ ...target, cutoverAt });
    const options = { cutoverAt: '2099-11-01T12:00:00Z', stateDir, owners, sendEmail };
    expect(await runPoolNotifications({ ...options, send: false })).toMatchObject({
      recipients: 3,
      remaining: 3,
    });
    expect(captureMail).not.toHaveBeenCalled();
    expect(await runPoolNotifications({ ...options, send: true })).toMatchObject({
      sent: 3,
      remaining: 0,
      failed: 0,
    });
    expect(captureMail).toHaveBeenCalledTimes(3);
    const ownerMail = captureMail.mock.calls.find(
      ([mail]) => mail.to === owner.google_user_email
    )?.[0];
    expect(ownerMail?.html).toContain('Fixture first organization');
    expect(ownerMail?.html).toContain('Fixture second organization');
    expect(ownerMail?.html).toContain('kilo-auto/custom/efficient');
    expect(ownerMail?.html).toContain('kilo-auto/custom/org/efficient');
    expect(ownerMail?.html).not.toMatch(/\{\{/);
    expect(await runPoolNotifications({ ...options, send: true })).toMatchObject({
      sent: 0,
      skipped: 3,
    });
    expect(captureMail).toHaveBeenCalledTimes(3);
  });

  it('includes one-level inherited editors, deduplicates direct contacts, and keeps sibling membership isolated', async () => {
    const grandparentOwner = await seedUser();
    const owner = await seedUser();
    const admin = await seedUser();
    const billing = await seedUser();
    const member = await seedUser();
    const bot = await seedUser({ is_bot: true });
    const siblingOwner = await seedUser();
    const grandparent = await seedOrganization('Fixture grandparent');
    const parent = await seedOrganization('Fixture parent', false, grandparent.id);
    const child = await seedOrganization('Fixture child', false, parent.id);
    const inheritedOnlyChild = await seedOrganization(
      'Fixture inherited contacts only',
      false,
      parent.id
    );
    const sibling = await seedOrganization('Fixture sibling', false, parent.id);
    const childRouter = await seedRouter({ organizationId: child.id });
    const inheritedOnlyRouter = await seedRouter({ organizationId: inheritedOnlyChild.id });
    await db.insert(organization_memberships).values([
      { organization_id: grandparent.id, kilo_user_id: grandparentOwner.id, role: 'owner' },
      { organization_id: parent.id, kilo_user_id: owner.id, role: 'owner' },
      { organization_id: parent.id, kilo_user_id: admin.id, role: 'admin' },
      { organization_id: parent.id, kilo_user_id: billing.id, role: 'billing_manager' },
      { organization_id: parent.id, kilo_user_id: member.id, role: 'member' },
      { organization_id: parent.id, kilo_user_id: bot.id, role: 'owner' },
      { organization_id: child.id, kilo_user_id: owner.id, role: 'owner' },
      { organization_id: child.id, kilo_user_id: billing.id, role: 'member' },
      { organization_id: sibling.id, kilo_user_id: siblingOwner.id, role: 'owner' },
    ]);

    const owners = await discoverPoolNotificationOwners(db);
    const expectedEmails = [
      owner.google_user_email,
      admin.google_user_email,
      billing.google_user_email,
    ].sort();
    for (const router of [childRouter, inheritedOnlyRouter]) {
      const discovered = owners.find(item => item.routers.some(pool => pool.id === router.id));
      expect(discovered?.emails.sort()).toEqual(expectedEmails);
    }
    const { targets } = buildPoolNotificationTargets(owners);
    expect(targets.map(target => target.to).sort()).toEqual(expectedEmails);
    for (const target of targets) {
      expect(target.routers.map(router => router.id).sort()).toEqual(
        [childRouter.id, inheritedOnlyRouter.id].sort()
      );
    }
    stateDir = await mkdtemp(join(tmpdir(), 'pool-inherited-contacts-'));
    expect(
      await runPoolNotifications({
        cutoverAt: '2099-11-01T12:00:00Z',
        stateDir,
        owners,
        send: false,
        sendEmail: (target, cutoverAt) => sendAutoRoutingPoolNoticeEmail({ ...target, cutoverAt }),
      })
    ).toMatchObject({ recipients: 3, remaining: 3 });
    expect(captureMail).not.toHaveBeenCalled();
  });

  it('excludes soft-deleted personal owners and soft-deleted direct or inherited billing contacts', async () => {
    const deletedOwner = await seedUser({ blocked_reason: createSoftDeletedBlockedReason() });
    const deletingOwner = await seedUser({
      blocked_reason: createDeletionInProgressBlockedReason(),
    });
    const liveAdmin = await seedUser();
    const deletedAdmin = await seedUser({ blocked_reason: createSoftDeletedBlockedReason() });
    const deletedParentOwner = await seedUser({
      blocked_reason: createSoftDeletedBlockedReason(),
    });
    const deletedPersonal = await seedRouter({ userId: deletedOwner.id });
    const deletingPersonal = await seedRouter({ userId: deletingOwner.id });
    const parent = await seedOrganization('Fixture deleted parent contact');
    const child = await seedOrganization('Fixture child with deleted contacts', false, parent.id);
    const childRouter = await seedRouter({ organizationId: child.id });
    await db.insert(organization_memberships).values([
      { organization_id: child.id, kilo_user_id: liveAdmin.id, role: 'admin' },
      { organization_id: child.id, kilo_user_id: deletedAdmin.id, role: 'owner' },
      { organization_id: parent.id, kilo_user_id: deletedParentOwner.id, role: 'owner' },
    ]);

    const owners = await discoverPoolNotificationOwners(db);
    const discoveredIds = owners.flatMap(item => item.routers.map(router => router.id));
    expect(discoveredIds).not.toContain(deletedPersonal.id);
    expect(discoveredIds).not.toContain(deletingPersonal.id);
    expect(
      owners.find(item => item.routers.some(pool => pool.id === childRouter.id))?.emails
    ).toEqual([liveAdmin.google_user_email]);
  });

  it('reports an organization with no live billing contact as unreachable and still plans the others', async () => {
    const owner = await seedUser();
    const personal = await seedRouter({ userId: owner.id });
    const organization = await seedOrganization('Fixture no billing contact');
    const ordinaryMember = await seedUser();
    const deletedOwner = await seedUser({ blocked_reason: createSoftDeletedBlockedReason() });
    const orgRouter = await seedRouter({ organizationId: organization.id });
    await db.insert(organization_memberships).values([
      { organization_id: organization.id, kilo_user_id: ordinaryMember.id, role: 'member' },
      { organization_id: organization.id, kilo_user_id: deletedOwner.id, role: 'owner' },
    ]);
    const owners = await discoverPoolNotificationOwners(db);
    const { targets, unreachable } = buildPoolNotificationTargets(owners);
    expect(unreachable.flat().map(router => router.id)).toContain(orgRouter.id);
    expect(targets.find(target => target.to === owner.google_user_email)?.routers).toEqual([
      expect.objectContaining({ id: personal.id }),
    ]);
    stateDir = await mkdtemp(join(tmpdir(), 'pool-missing-contact-'));
    const options = {
      cutoverAt: '2099-11-01T12:00:00Z',
      stateDir,
      owners,
      sendEmail: (target: (typeof targets)[number], cutoverAt: string) =>
        sendAutoRoutingPoolNoticeEmail({ ...target, cutoverAt }),
    };
    const dryRun = await runPoolNotifications({ ...options, send: false });
    expect(dryRun).toMatchObject({ unreachable: unreachable.length });
    expect(JSON.stringify(dryRun)).not.toContain(organization.id);
    expect(captureMail).not.toHaveBeenCalled();
    expect(await runPoolNotifications({ ...options, send: true })).toMatchObject({
      failed: 0,
      remaining: 0,
      unreachable: unreachable.length,
    });
    expect(captureMail.mock.calls.map(([mail]) => mail.to)).toContain(owner.google_user_email);
  });
});
