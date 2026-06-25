import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import {
  organizations,
  credit_transactions,
  organization_audit_logs,
  organization_memberships,
} from '@kilocode/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { hasOrganizationEverPaid } from '@/lib/creditTransactions';
import type { User, Organization } from '@kilocode/db/schema';

let ownerUser: User;
let parentOrg: Organization;
let childA: Organization;
let childB: Organization;
let unrelatedOrg: Organization;

async function setChildOf(childId: string, parentId: string) {
  await db
    .update(organizations)
    .set({ parent_organization_id: parentId })
    .where(eq(organizations.id, childId));
}

async function setBalance(organizationId: string, acquired: number, used: number) {
  await db
    .update(organizations)
    .set({
      total_microdollars_acquired: acquired,
      microdollars_used: used,
      microdollars_balance: acquired - used,
      next_credit_expiration_at: null,
    })
    .where(eq(organizations.id, organizationId));
}

function balanceOf(org: { total_microdollars_acquired: number; microdollars_used: number }) {
  return org.total_microdollars_acquired - org.microdollars_used;
}

async function getOrg(organizationId: string) {
  const [org] = await db
    .select({
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      microdollars_used: organizations.microdollars_used,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return org;
}

describe('organization funds router', () => {
  beforeAll(async () => {
    ownerUser = await insertTestUser({
      google_user_email: 'funds-owner@example.com',
      google_user_name: 'Funds Owner',
      is_admin: false,
    });

    parentOrg = await createOrganization('Funds Parent Org', ownerUser.id);
    childA = await createOrganization('Funds Child A', ownerUser.id);
    childB = await createOrganization('Funds Child B', ownerUser.id);
    unrelatedOrg = await createOrganization('Funds Unrelated Org', ownerUser.id);

    await setChildOf(childA.id, parentOrg.id);
    await setChildOf(childB.id, parentOrg.id);
  });

  afterAll(async () => {
    const orgIds = [parentOrg.id, childA.id, childB.id, unrelatedOrg.id];
    await db
      .delete(credit_transactions)
      .where(inArray(credit_transactions.organization_id, orgIds));
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, orgIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, orgIds));
    // Children must be removed before the parent (FK onDelete: restrict).
    await db.delete(organizations).where(inArray(organizations.id, [childA.id, childB.id]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [parentOrg.id, unrelatedOrg.id]));
  });

  beforeEach(async () => {
    await setBalance(parentOrg.id, 5_000_000, 0);
    await setBalance(childA.id, 0, 0);
    await setBalance(childB.id, 0, 0);
    await setBalance(unrelatedOrg.id, 0, 0);
    const orgIds = [parentOrg.id, childA.id, childB.id, unrelatedOrg.id];
    await db
      .delete(credit_transactions)
      .where(inArray(credit_transactions.organization_id, orgIds));
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, orgIds));
  });

  describe('childBalances', () => {
    it('returns parent balance, child balances, and the expiring-credits flag', async () => {
      await setBalance(childA.id, 3_000_000, 1_000_000);
      const caller = await createCallerForUser(ownerUser.id);

      const result = await caller.organizations.funds.childBalances({
        organizationId: parentOrg.id,
      });

      expect(result.parentBalanceMicrodollars).toBe(5_000_000);
      expect(result.hasExpiringCredits).toBe(false);
      const childAResult = result.children.find(child => child.id === childA.id);
      const childBResult = result.children.find(child => child.id === childB.id);
      expect(childAResult?.balanceMicrodollars).toBe(2_000_000);
      expect(childBResult?.balanceMicrodollars).toBe(0);
      expect(result.children.some(child => child.id === unrelatedOrg.id)).toBe(false);
    });

    it('processes due expirations for children before returning their balance', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      await db
        .update(organizations)
        .set({
          total_microdollars_acquired: 2_000_000,
          microdollars_used: 0,
          microdollars_balance: 2_000_000,
          next_credit_expiration_at: past,
        })
        .where(eq(organizations.id, childA.id));
      await db.insert(credit_transactions).values({
        kilo_user_id: 'system',
        is_free: true,
        amount_microdollars: 2_000_000,
        description: 'Expiring grant',
        credit_category: 'organization_custom',
        expiry_date: past,
        organization_id: childA.id,
        original_baseline_microdollars_used: 0,
        expiration_baseline_microdollars_used: 0,
      });

      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.funds.childBalances({
        organizationId: parentOrg.id,
      });

      const childAResult = result.children.find(child => child.id === childA.id);
      expect(childAResult?.balanceMicrodollars).toBe(0);

      // Expiry was actually processed: the child's expiry hint is cleared.
      const [updated] = await db
        .select({ next: organizations.next_credit_expiration_at })
        .from(organizations)
        .where(eq(organizations.id, childA.id));
      expect(updated.next).toBeNull();
    });

    it('reports hasExpiringCredits when the parent has a future expiry date', async () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await db
        .update(organizations)
        .set({ next_credit_expiration_at: future })
        .where(eq(organizations.id, parentOrg.id));

      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.organizations.funds.childBalances({
        organizationId: parentOrg.id,
      });

      expect(result.hasExpiringCredits).toBe(true);
    });
  });

  describe('distribute', () => {
    it('moves funds from parent to children and records ledger transactions', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const result = await caller.organizations.funds.distribute({
        organizationId: parentOrg.id,
        allocations: [
          { childOrganizationId: childA.id, amountMicrodollars: 2_000_000 },
          { childOrganizationId: childB.id, amountMicrodollars: 1_000_000 },
        ],
      });

      expect(result.totalMovedMicrodollars).toBe(3_000_000);
      expect(result.childCount).toBe(2);

      expect(balanceOf(await getOrg(parentOrg.id))).toBe(2_000_000);
      expect(balanceOf(await getOrg(childA.id))).toBe(2_000_000);
      expect(balanceOf(await getOrg(childB.id))).toBe(1_000_000);

      const childAIncoming = await db
        .select()
        .from(credit_transactions)
        .where(
          and(
            eq(credit_transactions.organization_id, childA.id),
            eq(credit_transactions.credit_category, 'parent_to_child_transfer_in')
          )
        );
      expect(childAIncoming).toHaveLength(1);
      expect(childAIncoming[0].amount_microdollars).toBe(2_000_000);
      expect(childAIncoming[0].expiry_date).toBeNull();
      // A transfer is a balance movement, not a purchase: it must not be
      // recorded as paid, or it would fabricate paid provenance downstream.
      expect(childAIncoming[0].is_free).toBe(true);

      const parentOutgoing = await db
        .select()
        .from(credit_transactions)
        .where(
          and(
            eq(credit_transactions.organization_id, parentOrg.id),
            eq(credit_transactions.credit_category, 'parent_to_child_transfer_out')
          )
        );
      expect(parentOutgoing).toHaveLength(2);
      const total = parentOutgoing.reduce((sum, tx) => sum + tx.amount_microdollars, 0);
      expect(total).toBe(-3_000_000);

      const parentAuditLogs = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, parentOrg.id),
            eq(organization_audit_logs.action, 'organization.funds.distribute_to_children')
          )
        );
      expect(parentAuditLogs).toHaveLength(1);
    });

    it('does not mark the child or parent as having ever paid', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await caller.organizations.funds.distribute({
        organizationId: parentOrg.id,
        allocations: [{ childOrganizationId: childA.id, amountMicrodollars: 1_000_000 }],
      });

      // Neither org made a purchase; the transfer must not flip the paid gate
      // that gates deployments and notifications.
      expect(await hasOrganizationEverPaid(childA.id)).toBe(false);
      expect(await hasOrganizationEverPaid(parentOrg.id)).toBe(false);
    });

    it('rejects when the total exceeds the available balance', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await expect(
        caller.organizations.funds.distribute({
          organizationId: parentOrg.id,
          allocations: [{ childOrganizationId: childA.id, amountMicrodollars: 6_000_000 }],
        })
      ).rejects.toThrow('exceeds the available balance');

      // Nothing should have moved.
      expect(balanceOf(await getOrg(parentOrg.id))).toBe(5_000_000);
      expect(balanceOf(await getOrg(childA.id))).toBe(0);
    });

    it('rejects when a target is not a direct child organization', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await expect(
        caller.organizations.funds.distribute({
          organizationId: parentOrg.id,
          allocations: [{ childOrganizationId: unrelatedOrg.id, amountMicrodollars: 1_000_000 }],
        })
      ).rejects.toThrow('must be direct child organizations');

      expect(balanceOf(await getOrg(parentOrg.id))).toBe(5_000_000);
      expect(balanceOf(await getOrg(unrelatedOrg.id))).toBe(0);
    });

    it('rejects while the parent has expiring credits', async () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await db
        .update(organizations)
        .set({ next_credit_expiration_at: future })
        .where(eq(organizations.id, parentOrg.id));

      const caller = await createCallerForUser(ownerUser.id);

      await expect(
        caller.organizations.funds.distribute({
          organizationId: parentOrg.id,
          allocations: [{ childOrganizationId: childA.id, amountMicrodollars: 1_000_000 }],
        })
      ).rejects.toThrow('expiring credits');

      expect(balanceOf(await getOrg(parentOrg.id))).toBe(5_000_000);
      expect(balanceOf(await getOrg(childA.id))).toBe(0);
    });
  });
});
