import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import {
  organizations,
  organization_memberships,
  organization_audit_logs,
  credit_transactions,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import type { User, Organization } from '@kilocode/db/schema';

let parentOwner: User;
let parentBillingManager: User;
let parentMember: User;
let childOwner: User;
let childAExtraMember: User;
let childABillingManager: User;
let childABotMember: User;
let parentOrg: Organization;
let childA: Organization;
let childB: Organization;
let childCDeleted: Organization;
let unrelatedOrg: Organization;

async function setChildOf(childId: string, parentId: string) {
  await db
    .update(organizations)
    .set({ parent_organization_id: parentId })
    .where(eq(organizations.id, childId));
}

async function softDelete(organizationId: string) {
  await db
    .update(organizations)
    .set({ deleted_at: new Date().toISOString() })
    .where(eq(organizations.id, organizationId));
}

async function expectUnauthorized(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
}

describe('organization sub-organizations router', () => {
  beforeAll(async () => {
    parentOwner = await insertTestUser({
      google_user_email: 'suborg-overview-parent-owner@example.com',
      google_user_name: 'Suborg Parent Owner',
      is_admin: false,
    });
    parentBillingManager = await insertTestUser({
      google_user_email: 'suborg-overview-parent-billing@example.com',
      google_user_name: 'Suborg Parent Billing Manager',
      is_admin: false,
    });
    parentMember = await insertTestUser({
      google_user_email: 'suborg-overview-parent-member@example.com',
      google_user_name: 'Suborg Parent Member',
      is_admin: false,
    });
    childOwner = await insertTestUser({
      google_user_email: 'suborg-overview-child-owner@example.com',
      google_user_name: 'Suborg Child Owner',
      is_admin: false,
    });
    childAExtraMember = await insertTestUser({
      google_user_email: 'suborg-overview-child-a-extra@example.com',
      google_user_name: 'Suborg Child A Extra Member',
      is_admin: false,
    });
    childABillingManager = await insertTestUser({
      google_user_email: 'suborg-overview-child-a-billing@example.com',
      google_user_name: 'Suborg Child A Billing Manager',
      is_admin: false,
    });
    childABotMember = await insertTestUser({
      google_user_email: 'suborg-overview-child-a-bot@example.com',
      google_user_name: 'Suborg Child A Bot Member',
      is_admin: false,
      is_bot: true,
    });

    parentOrg = await createOrganization('Suborg Overview Parent', parentOwner.id);
    await addUserToOrganization(parentOrg.id, parentBillingManager.id, 'billing_manager');
    await addUserToOrganization(parentOrg.id, parentMember.id, 'member');

    // childA is owned by childOwner (who is NOT a member of the parent), with an
    // extra member so its member count is distinguishable from childB. It also
    // has a billing_manager and a bot member, which must NOT count toward
    // memberCount (matches the surfaced member-count convention in
    // organization-admin-router, which excludes billing-manager seats and bots).
    childA = await createOrganization('Suborg Overview Child A', childOwner.id);
    await addUserToOrganization(childA.id, childAExtraMember.id, 'member');
    await addUserToOrganization(childA.id, childABillingManager.id, 'billing_manager');
    await addUserToOrganization(childA.id, childABotMember.id, 'member');

    // childB is on the 'enterprise' plan so the plan field is exercised.
    childB = await createOrganization(
      'Suborg Overview Child B',
      parentOwner.id,
      true,
      undefined,
      'enterprise'
    );

    // childC is soft-deleted and must never appear in the overview.
    childCDeleted = await createOrganization('Suborg Overview Child C Deleted', parentOwner.id);

    unrelatedOrg = await createOrganization('Suborg Overview Unrelated Org', parentOwner.id);

    await setChildOf(childA.id, parentOrg.id);
    await setChildOf(childB.id, parentOrg.id);
    await setChildOf(childCDeleted.id, parentOrg.id);
    await softDelete(childCDeleted.id);
  });

  afterAll(async () => {
    const orgIds = [parentOrg.id, childA.id, childB.id, childCDeleted.id, unrelatedOrg.id];
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, orgIds));
    await db
      .delete(credit_transactions)
      .where(inArray(credit_transactions.organization_id, orgIds));
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, orgIds));
    // Children must be removed before the parent (FK onDelete: restrict).
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [childA.id, childB.id, childCDeleted.id]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [parentOrg.id, unrelatedOrg.id]));
  });

  describe('overview', () => {
    it('returns all non-deleted children for the parent owner', async () => {
      const caller = await createCallerForUser(parentOwner.id);
      const result = await caller.organizations.subOrganizations.overview({
        organizationId: parentOrg.id,
      });

      const ids = result.children.map(child => child.id);
      expect(ids).toEqual([childA.id, childB.id]);
      expect(ids).not.toContain(childCDeleted.id);

      const childAResult = result.children.find(child => child.id === childA.id);
      expect(childAResult).toMatchObject({
        id: childA.id,
        name: 'Suborg Overview Child A',
        plan: 'teams',
        memberCount: 2,
      });
      // childB is owned by parentOwner (one member) and is on the enterprise plan.
      const childBResult = result.children.find(child => child.id === childB.id);
      expect(childBResult).toMatchObject({
        id: childB.id,
        name: 'Suborg Overview Child B',
        plan: 'enterprise',
        memberCount: 1,
      });
      // created_at is normalized to a strict ISO datetime at the contract boundary.
      for (const child of result.children) {
        expect(child.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
        expect(new Date(child.createdAt).toISOString()).toBe(child.createdAt);
      }
    });

    it('excludes billing-manager seats and bot users from memberCount', async () => {
      // childA has four raw memberships: owner, a plain member, a billing
      // manager, and a bot member. The surfaced memberCount must exclude the
      // billing-manager seat and the bot user, matching the convention in
      // organization-admin-router (and getUserOrganizationsWithSeats).
      const caller = await createCallerForUser(parentOwner.id);
      const result = await caller.organizations.subOrganizations.overview({
        organizationId: parentOrg.id,
      });

      const childAResult = result.children.find(child => child.id === childA.id);
      expect(childAResult?.memberCount).toBe(2);
    });

    it('returns all non-deleted children for the parent billing_manager', async () => {
      const caller = await createCallerForUser(parentBillingManager.id);
      const result = await caller.organizations.subOrganizations.overview({
        organizationId: parentOrg.id,
      });

      const ids = result.children.map(child => child.id);
      expect(ids).toEqual([childA.id, childB.id]);
    });

    it('rejects a plain parent member', async () => {
      const caller = await createCallerForUser(parentMember.id);
      await expectUnauthorized(
        caller.organizations.subOrganizations.overview({ organizationId: parentOrg.id })
      );
    });

    it('rejects a child owner for the parent endpoint', async () => {
      const caller = await createCallerForUser(childOwner.id);
      await expectUnauthorized(
        caller.organizations.subOrganizations.overview({ organizationId: parentOrg.id })
      );
    });

    it('excludes soft-deleted children', async () => {
      const caller = await createCallerForUser(parentOwner.id);
      const result = await caller.organizations.subOrganizations.overview({
        organizationId: parentOrg.id,
      });
      expect(result.children.some(child => child.id === childCDeleted.id)).toBe(false);
    });

    it('returns an empty list for a parent with zero children', async () => {
      const caller = await createCallerForUser(parentOwner.id);
      const result = await caller.organizations.subOrganizations.overview({
        organizationId: unrelatedOrg.id,
      });
      expect(result.children).toEqual([]);
    });

    it('does not scale the query count with the number of children', async () => {
      const caller = await createCallerForUser(parentOwner.id);

      const countSelects = async () => {
        const selectSpy = jest.spyOn(db, 'select');
        try {
          await caller.organizations.subOrganizations.overview({
            organizationId: parentOrg.id,
          });
          return selectSpy.mock.calls.length;
        } finally {
          selectSpy.mockRestore();
        }
      };

      const baselineSelects = await countSelects();

      // Add a third visible child and confirm the select count is unchanged.
      const extraChild = await createOrganization('Suborg Overview Extra Child', parentOwner.id);
      await setChildOf(extraChild.id, parentOrg.id);
      try {
        const withExtraChildSelects = await countSelects();
        expect(withExtraChildSelects).toBe(baselineSelects);
        expect(baselineSelects).toBeGreaterThan(0);
      } finally {
        await db
          .delete(organization_memberships)
          .where(eq(organization_memberships.organization_id, extraChild.id));
        await db.delete(organizations).where(eq(organizations.id, extraChild.id));
      }
    });
  });
});
