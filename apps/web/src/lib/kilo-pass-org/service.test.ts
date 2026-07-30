import { afterEach, describe, expect, it } from '@jest/globals';
import {
  credit_transactions,
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plans,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_processing_runs,
  kilo_pass_org_supplements,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import { KiloPassOrgAgreementState } from '@kilocode/db/schema-types';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  activatePaidAgreement,
  createParentSupplement,
  createPendingAgreement,
  nextIssuanceBoundary,
  organizationKiloPassService,
  runOrganizationPassIssuanceCron,
  scheduleOrganizationPassCapacity,
  standardOrgPassTerms,
} from './service';

const window = {
  start: new Date('2026-07-01T00:00:00.000Z'),
  end: new Date('2026-08-01T00:00:00.000Z'),
};

describe('Kilo Pass organization agreement service', () => {
  const organizationIds: string[] = [];

  afterEach(async () => {
    if (!organizationIds.length) return;
    const ids = organizationIds.splice(0);
    await db
      .delete(kilo_pass_org_issuance_snapshots)
      .where(inArray(kilo_pass_org_issuance_snapshots.allocation_container_organization_id, ids));
    await db
      .delete(kilo_pass_org_agreements)
      .where(inArray(kilo_pass_org_agreements.parent_organization_id, ids));
    await db
      .delete(organization_seats_purchases)
      .where(inArray(organization_seats_purchases.organization_id, ids));
    await db.delete(credit_transactions).where(inArray(credit_transactions.organization_id, ids));
    await db
      .update(organizations)
      .set({ parent_organization_id: null })
      .where(inArray(organizations.id, ids));
    await db.delete(organizations).where(inArray(organizations.id, ids));
  });

  it('seeds concrete immutable standard terms and activates exactly once with parent remainder', async () => {
    expect(standardOrgPassTerms).toHaveLength(6);
    expect(
      standardOrgPassTerms
        .map(term => term.billingPriceMicrodollarsPerPass)
        .sort((left, right) => left - right)
    ).toEqual([19_000_000, 19_000_000, 49_000_000, 49_000_000, 199_000_000, 199_000_000]);
    expect(
      standardOrgPassTerms.map(term => ({
        tier: term.tier,
        billing: term.billingPriceMicrodollarsPerPass,
        base: term.baseCreditMicrodollarsPerPass,
        bonus: term.bonusCreditMicrodollarsPerPass,
        threshold: term.unlockSpendMicrodollarsPerPass,
      }))
    ).toEqual([
      {
        tier: 'tier_19',
        billing: 19_000_000,
        base: 19_000_000,
        bonus: 4_000_000,
        threshold: 19_000_000,
      },
      {
        tier: 'tier_19',
        billing: 19_000_000,
        base: 19_000_000,
        bonus: 4_000_000,
        threshold: 19_000_000,
      },
      {
        tier: 'tier_49',
        billing: 49_000_000,
        base: 49_000_000,
        bonus: 12_000_000,
        threshold: 49_000_000,
      },
      {
        tier: 'tier_49',
        billing: 49_000_000,
        base: 49_000_000,
        bonus: 12_000_000,
        threshold: 49_000_000,
      },
      {
        tier: 'tier_199',
        billing: 199_000_000,
        base: 199_000_000,
        bonus: 50_000_000,
        threshold: 199_000_000,
      },
      {
        tier: 'tier_199',
        billing: 199_000_000,
        base: 199_000_000,
        bonus: 50_000_000,
        threshold: 199_000_000,
      },
    ]);

    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(`kpo-parent-${crypto.randomUUID()}`, owner.id);
    const child = await createOrganization(`kpo-child-${crypto.randomUUID()}`, childOwner.id);
    organizationIds.push(parent.id, child.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));

    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 3,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 1 }],
    });
    const providerEventId = `evt_${crypto.randomUUID()}`;
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 3,
      firstWindow: window,
      isBridge: false,
      providerEventId,
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 3,
      firstWindow: window,
      isBridge: false,
      providerEventId,
    });

    const snapshots = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(eq(kilo_pass_org_issuance_snapshots.agreement_id, pending.agreementId));
    expect(snapshots).toHaveLength(2);
    expect(
      snapshots
        .map(snapshot => [
          snapshot.allocation_container_organization_id,
          snapshot.allocated_pass_capacity,
        ])
        .sort()
    ).toEqual(
      [
        [child.id, 1],
        [parent.id, 2],
      ].sort()
    );
    const credits = await db
      .select()
      .from(credit_transactions)
      .where(inArray(credit_transactions.organization_id, [parent.id, child.id]));
    expect(credits).toHaveLength(2);
  });

  it('returns the latest immutable issuance separately from the next allocation plan', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(`kpo-detail-parent-${crypto.randomUUID()}`, owner.id);
    const child = await createOrganization(
      `kpo-detail-child-${crypto.randomUUID()}`,
      childOwner.id
    );
    const unassignedChild = await createOrganization(
      `kpo-detail-unassigned-child-${crypto.randomUUID()}`,
      childOwner.id
    );
    organizationIds.push(parent.id, child.id, unassignedChild.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(inArray(organizations.id, [child.id, unassignedChild.id]));
    const now = new Date();
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextWindowStart = nextIssuanceBoundary(anchor, now);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 3,
      issuanceAnchorAt: anchor,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 1 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: anchor,
      paidUntil: new Date(nextWindowStart.getTime() + 31 * 24 * 60 * 60 * 1000),
      paidSeatCount: 3,
      firstWindow: { start: anchor, end: nextWindowStart },
      isBridge: false,
    });
    await organizationKiloPassService.updateAllocation({
      organizationId: parent.id,
      actorUserId: owner.id,
      expectedPlanVersion: 1,
      allocations: [{ childOrganizationId: child.id, passCount: 2 }],
    });

    const detail = await organizationKiloPassService.getDetail({ organizationId: parent.id });

    expect(detail.currentAllocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: parent.id,
          organizationName: parent.name,
          kind: 'parent',
          passCount: 2,
          hasProratedCredits: false,
          baseCreditsMicrodollars: 38_000_000,
          qualifyingSpendMicrodollars: 0,
          unlockTargetMicrodollars: 38_000_000,
          bonusCreditsMicrodollars: 8_000_000,
          bonusState: 'locked',
        }),
        expect.objectContaining({ organizationId: child.id, kind: 'child', passCount: 1 }),
        expect.objectContaining({
          organizationId: unassignedChild.id,
          organizationName: unassignedChild.name,
          kind: 'child',
          passCount: 0,
          baseCreditsMicrodollars: 0,
          qualifyingSpendMicrodollars: 0,
          unlockTargetMicrodollars: 0,
          bonusCreditsMicrodollars: 0,
          bonusState: 'locked',
        }),
      ])
    );
    expect(detail.nextAllocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: parent.id, passCount: 1 }),
        expect.objectContaining({ organizationId: child.id, passCount: 2 }),
      ])
    );
  });

  it('projects issued capacity and leaves newly added passes with the parent next period', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(
      `kpo-capacity-projection-${crypto.randomUUID()}`,
      owner.id
    );
    const child = await createOrganization(
      `kpo-capacity-projection-child-${crypto.randomUUID()}`,
      childOwner.id
    );
    organizationIds.push(parent.id, child.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    const now = new Date();
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextWindowStart = nextIssuanceBoundary(anchor, now);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 20,
      issuanceAnchorAt: anchor,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 20 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: anchor,
      paidUntil: nextWindowStart,
      paidSeatCount: 20,
      firstWindow: { start: anchor, end: nextWindowStart },
      isBridge: false,
    });
    await createParentSupplement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      window: { start: anchor, end: nextWindowStart },
      paidSeatCount: 22,
      providerInvoiceLineId: `line_${crypto.randomUUID()}`,
      now,
    });
    await db
      .update(kilo_pass_org_agreements)
      .set({ purchased_pass_capacity: 20 })
      .where(eq(kilo_pass_org_agreements.id, pending.agreementId));

    const [summary, detail] = await Promise.all([
      organizationKiloPassService.getSummary({ organizationId: parent.id }),
      organizationKiloPassService.getDetail({ organizationId: parent.id }),
    ]);

    expect(summary.agreement?.paidSeatCount).toBe(22);
    expect(detail.paidSeatCount).toBe(22);
    expect(detail.nextAllocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: child.id, passCount: 20 }),
        expect.objectContaining({ organizationId: parent.id, passCount: 2 }),
      ])
    );
  });

  it('keeps current capacity while validating upcoming assignments against a scheduled decrease', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(`kpo-decrease-parent-${crypto.randomUUID()}`, owner.id);
    const child = await createOrganization(
      `kpo-decrease-child-${crypto.randomUUID()}`,
      childOwner.id
    );
    organizationIds.push(parent.id, child.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    const now = new Date();
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const paidUntil = nextIssuanceBoundary(anchor, now);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 25,
      issuanceAnchorAt: anchor,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 20 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: anchor,
      paidUntil,
      paidSeatCount: 25,
      firstWindow: { start: anchor, end: paidUntil },
      isBridge: false,
    });

    await expect(
      scheduleOrganizationPassCapacity({ organizationId: parent.id, paidSeatCount: 10 })
    ).resolves.toEqual({ scheduled: true, overallocated: true });
    const detail = await organizationKiloPassService.getDetail({ organizationId: parent.id });

    expect(detail.paidSeatCount).toBe(25);
    expect(detail.nextPaidSeatCount).toBe(10);
    expect(detail.processingCondition).toBe('overallocated');
    expect(detail.nextAllocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: child.id, passCount: 20 }),
        expect.objectContaining({ organizationId: parent.id, passCount: 0 }),
      ])
    );
  });

  it('replaces a scheduled decrease when a later paid increase supersedes its provider quantity', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(`kpo-reincrease-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(parent.id);
    const anchor = new Date('2026-07-01T00:00:00.000Z');
    const paidUntil = new Date('2026-08-01T00:00:00.000Z');
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 25,
      issuanceAnchorAt: anchor,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: anchor,
      paidUntil,
      paidSeatCount: 25,
      firstWindow: { start: anchor, end: paidUntil },
      isBridge: false,
    });
    await scheduleOrganizationPassCapacity({ organizationId: parent.id, paidSeatCount: 10 });

    const increaseStart = new Date('2026-07-15T00:00:00.000Z');
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: increaseStart,
      paidUntil,
      paidSeatCount: 30,
      firstWindow: { start: anchor, end: paidUntil },
      isBridge: true,
      paidBridgeInterval: { start: increaseStart, end: paidUntil },
    });

    const [agreement] = await db
      .select()
      .from(kilo_pass_org_agreements)
      .where(eq(kilo_pass_org_agreements.id, pending.agreementId));
    expect(agreement).toMatchObject({
      purchased_pass_capacity: 30,
      next_purchased_pass_capacity: null,
      next_capacity_effective_at: null,
    });
  });

  it('clears a scheduled decrease when a partial paid increase supersedes it', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(
      `kpo-partial-reincrease-${crypto.randomUUID()}`,
      owner.id
    );
    organizationIds.push(parent.id);
    const anchor = new Date('2026-07-01T00:00:00.000Z');
    const paidUntil = new Date('2026-08-01T00:00:00.000Z');
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 25,
      issuanceAnchorAt: anchor,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: anchor,
      paidUntil,
      paidSeatCount: 25,
      firstWindow: { start: anchor, end: paidUntil },
      isBridge: false,
    });
    await scheduleOrganizationPassCapacity({ organizationId: parent.id, paidSeatCount: 10 });
    const increaseStart = new Date('2026-07-15T00:00:00.000Z');
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: increaseStart,
      paidUntil,
      paidSeatCount: 12,
      firstWindow: { start: anchor, end: paidUntil },
      isBridge: true,
      paidBridgeInterval: { start: increaseStart, end: paidUntil },
    });

    const [agreement] = await db
      .select()
      .from(kilo_pass_org_agreements)
      .where(eq(kilo_pass_org_agreements.id, pending.agreementId));
    expect(agreement).toMatchObject({
      purchased_pass_capacity: 12,
      next_purchased_pass_capacity: null,
      next_capacity_effective_at: null,
    });
    await expect(
      organizationKiloPassService.updateAllocation({
        organizationId: parent.id,
        actorUserId: owner.id,
        expectedPlanVersion: 1,
        allocations: [],
      })
    ).resolves.toMatchObject({ planVersion: 2 });
  });

  it('allows paid pass capacity to decrease for a later renewal period', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(
      `kpo-capacity-renewal-${crypto.randomUUID()}`,
      owner.id
    );
    organizationIds.push(parent.id);
    const anchor = new Date('2026-07-01T00:00:00.000Z');
    const firstPaidUntil = new Date('2026-08-01T00:00:00.000Z');
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 22,
      issuanceAnchorAt: anchor,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: anchor,
      paidUntil: firstPaidUntil,
      paidSeatCount: 22,
      firstWindow: { start: anchor, end: firstPaidUntil },
      isBridge: false,
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: firstPaidUntil,
      paidUntil: new Date('2026-09-01T00:00:00.000Z'),
      paidSeatCount: 20,
      firstWindow: {
        start: firstPaidUntil,
        end: new Date('2026-09-01T00:00:00.000Z'),
      },
      isBridge: false,
    });

    const [agreement] = await db
      .select()
      .from(kilo_pass_org_agreements)
      .where(eq(kilo_pass_org_agreements.id, pending.agreementId));
    expect(agreement?.purchased_pass_capacity).toBe(20);
  });

  it('includes unassigned direct children in editable next allocations', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(
      `kpo-unassigned-parent-${crypto.randomUUID()}`,
      owner.id
    );
    const assignedChild = await createOrganization(
      `kpo-assigned-child-${crypto.randomUUID()}`,
      childOwner.id
    );
    const unassignedChild = await createOrganization(
      `kpo-unassigned-child-${crypto.randomUUID()}`,
      childOwner.id
    );
    organizationIds.push(parent.id, assignedChild.id, unassignedChild.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(inArray(organizations.id, [assignedChild.id, unassignedChild.id]));
    await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 3,
      issuanceAnchorAt: new Date(),
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: assignedChild.id, passCapacity: 1 }],
    });

    const detail = await organizationKiloPassService.getDetail({ organizationId: parent.id });

    expect(detail.nextAllocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: assignedChild.id, passCount: 1, kind: 'child' }),
        expect.objectContaining({
          organizationId: unassignedChild.id,
          passCount: 0,
          kind: 'child',
        }),
        expect.objectContaining({ organizationId: parent.id, passCount: 2, kind: 'parent' }),
      ])
    );
  });

  it('keeps the latest ended agreement visible but uses current organization defaults for restart', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(`kpo-ended-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(parent.id);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_49',
      cadence: 'yearly',
      paidSeatCount: 7,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await db
      .update(kilo_pass_org_agreements)
      .set({ state: KiloPassOrgAgreementState.Ended })
      .where(eq(kilo_pass_org_agreements.id, pending.agreementId));

    await expect(
      organizationKiloPassService.getSummary({ organizationId: parent.id })
    ).resolves.toEqual(
      expect.objectContaining({
        state: 'ended',
        commercialState: 'ended',
        agreement: expect.objectContaining({ tier: 'tier_49', paidSeatCount: 7 }),
      })
    );
    await db.insert(organization_seats_purchases).values({
      organization_id: parent.id,
      subscription_stripe_id: `sub_${crypto.randomUUID()}`,
      seat_count: parent.seat_count,
      amount_usd: parent.seat_count * 18,
      expires_at: '2026-09-01T00:00:00.000Z',
      starts_at: '2026-08-01T00:00:00.000Z',
      subscription_status: 'active',
      billing_cycle: 'yearly',
    });
    await expect(
      organizationKiloPassService.getSetup({ organizationId: parent.id })
    ).resolves.toEqual(
      expect.objectContaining({
        paidSeatCount: parent.seat_count,
        cadence: 'yearly',
        renewalAt: '2026-09-01T00:00:00.000Z',
        planVersion: 0,
      })
    );
  });

  it('rejects non-child allocation and stale plan writes', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(`kpo-parent-${crypto.randomUUID()}`, owner.id);
    const unrelated = await createOrganization(`kpo-unrelated-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(parent.id, unrelated.id);
    await expect(
      createPendingAgreement({
        parentOrganizationId: parent.id,
        actorUserId: owner.id,
        tier: 'tier_49',
        cadence: 'yearly',
        paidSeatCount: 1,
        issuanceAnchorAt: window.start,
        providerSubscriptionId: `sub_${crypto.randomUUID()}`,
        providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
        initialAllocations: [{ organizationId: unrelated.id, passCapacity: 1 }],
      })
    ).rejects.toThrow('direct child');

    await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_49',
      cadence: 'yearly',
      paidSeatCount: 1,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await expect(
      organizationKiloPassService.updateAllocation({
        organizationId: parent.id,
        actorUserId: owner.id,
        expectedPlanVersion: 0,
        allocations: [],
      })
    ).rejects.toThrow('STALE_PLAN_VERSION');
  });

  it('keeps an active agreement commercially active while an overallocated next plan is reconciled', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(`kpo-parent-${crypto.randomUUID()}`, owner.id);
    const child = await createOrganization(`kpo-child-${crypto.randomUUID()}`, childOwner.id);
    organizationIds.push(parent.id, child.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 2,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 1 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 2,
      firstWindow: window,
      isBridge: false,
    });
    await scheduleOrganizationPassCapacity({ organizationId: parent.id, paidSeatCount: 0 });

    const [summary, detail] = await Promise.all([
      organizationKiloPassService.getSummary({ organizationId: parent.id }),
      organizationKiloPassService.getDetail({ organizationId: parent.id }),
    ]);

    for (const projection of [summary, detail]) {
      expect(projection.state).toBe('active');
      expect(projection.commercialState).toBe('active');
      expect(projection.processingCondition).toBe('overallocated');
    }
    expect(detail.currentAllocations).toEqual(
      expect.arrayContaining([expect.objectContaining({ organizationId: parent.id, passCount: 1 })])
    );
    expect(detail.nextAllocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: parent.id, passCount: 0 }),
        expect.objectContaining({ organizationId: child.id, passCount: 1 }),
      ])
    );
  });

  it('reclaims a blocked original window after seat capacity reconciliation and issues it once', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(`kpo-retry-parent-${crypto.randomUUID()}`, owner.id);
    const child = await createOrganization(`kpo-retry-child-${crypto.randomUUID()}`, childOwner.id);
    organizationIds.push(parent.id, child.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 2,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 1 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: new Date('2026-09-01T00:00:00.000Z'),
      paidSeatCount: 2,
      firstWindow: window,
      isBridge: false,
    });
    await organizationKiloPassService.updateAllocation({
      organizationId: parent.id,
      actorUserId: owner.id,
      expectedPlanVersion: 1,
      allocations: [{ childOrganizationId: child.id, passCount: 2 }],
    });
    const augustWindow = {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-09-01T00:00:00.000Z'),
    };
    const blocked = await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: augustWindow.start,
      paidUntil: augustWindow.end,
      paidSeatCount: 1,
      firstWindow: augustWindow,
      isBridge: false,
    });
    expect(blocked).toEqual({ issued: false, blocked: true });
    const [blockedRun] = await db
      .select()
      .from(kilo_pass_org_processing_runs)
      .where(
        and(
          eq(kilo_pass_org_processing_runs.agreement_id, pending.agreementId),
          eq(kilo_pass_org_processing_runs.window_start, augustWindow.start.toISOString())
        )
      );
    expect(blockedRun?.state).toBe('blocked');
    expect(new Date(blockedRun?.window_start ?? 0).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(blockedRun?.attempt_count).toBe(0);
    if (!blockedRun) throw new Error('blocked processing run was not created');

    await organizationKiloPassService.updateAllocation({
      organizationId: parent.id,
      actorUserId: owner.id,
      expectedPlanVersion: 2,
      allocations: [{ childOrganizationId: child.id, passCount: 1 }],
    });
    const recovered = await runOrganizationPassIssuanceCron(
      db,
      new Date('2026-08-02T00:00:00.000Z')
    );
    const replay = await runOrganizationPassIssuanceCron(db, new Date('2026-08-02T00:00:00.000Z'));
    expect(recovered).toMatchObject({ issued: 1, blocked: 0 });
    expect(replay).toMatchObject({ issued: 0, blocked: 0 });
    const [recoveredRun] = await db
      .select()
      .from(kilo_pass_org_processing_runs)
      .where(eq(kilo_pass_org_processing_runs.id, blockedRun.id));
    expect(recoveredRun).toMatchObject({
      state: 'succeeded',
      window_start: blockedRun.window_start,
      window_end: blockedRun.window_end,
      attempt_count: 1,
    });
    const augustSnapshots = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(
        and(
          eq(kilo_pass_org_issuance_snapshots.agreement_id, pending.agreementId),
          eq(kilo_pass_org_issuance_snapshots.window_start, blockedRun.window_start)
        )
      );
    expect(augustSnapshots).toHaveLength(1);
  });

  it('reconciles a snapshotless blocked allocation window at its original boundary', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(
      `kpo-public-retry-parent-${crypto.randomUUID()}`,
      owner.id
    );
    const child = await createOrganization(
      `kpo-public-retry-child-${crypto.randomUUID()}`,
      childOwner.id
    );
    organizationIds.push(parent.id, child.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    const now = new Date();
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const blockedWindowStart = nextIssuanceBoundary(anchor, now);
    const blockedWindow = {
      start: blockedWindowStart,
      end: nextIssuanceBoundary(anchor, blockedWindowStart),
    };
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 2,
      issuanceAnchorAt: anchor,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 1 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: anchor,
      paidUntil: new Date(blockedWindow.end.getTime() + 31 * 24 * 60 * 60 * 1000),
      paidSeatCount: 2,
      firstWindow: { start: anchor, end: blockedWindowStart },
      isBridge: false,
    });
    await organizationKiloPassService.updateAllocation({
      organizationId: parent.id,
      actorUserId: owner.id,
      expectedPlanVersion: 1,
      allocations: [{ childOrganizationId: child.id, passCount: 2 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: blockedWindow.start,
      paidUntil: blockedWindow.end,
      paidSeatCount: 1,
      firstWindow: blockedWindow,
      isBridge: false,
    });

    const [blockedRun] = await db
      .select()
      .from(kilo_pass_org_processing_runs)
      .where(
        and(
          eq(kilo_pass_org_processing_runs.agreement_id, pending.agreementId),
          eq(kilo_pass_org_processing_runs.window_start, blockedWindowStart.toISOString())
        )
      );
    if (!blockedRun) throw new Error('blocked processing run was not created');
    const blockedSnapshots = await db
      .select({ id: kilo_pass_org_issuance_snapshots.id })
      .from(kilo_pass_org_issuance_snapshots)
      .where(
        and(
          eq(kilo_pass_org_issuance_snapshots.agreement_id, pending.agreementId),
          eq(kilo_pass_org_issuance_snapshots.window_start, blockedWindowStart.toISOString())
        )
      );
    expect(blockedSnapshots).toHaveLength(0);

    const reconciled = await organizationKiloPassService.updateAllocation({
      organizationId: parent.id,
      actorUserId: owner.id,
      expectedPlanVersion: 2,
      allocations: [{ childOrganizationId: child.id, passCount: 1 }],
    });
    expect(reconciled).toEqual({
      planVersion: 3,
      nextWindowStartsAt: blockedWindowStart.toISOString(),
    });

    const recovered = await runOrganizationPassIssuanceCron(
      db,
      new Date(blockedWindowStart.getTime() + 24 * 60 * 60 * 1000)
    );
    const replay = await runOrganizationPassIssuanceCron(
      db,
      new Date(blockedWindowStart.getTime() + 24 * 60 * 60 * 1000)
    );
    expect(recovered).toMatchObject({ issued: 1, blocked: 0 });
    expect(replay).toMatchObject({ issued: 0, blocked: 0 });
    const [recoveredRun] = await db
      .select()
      .from(kilo_pass_org_processing_runs)
      .where(eq(kilo_pass_org_processing_runs.id, blockedRun.id));
    expect(recoveredRun).toMatchObject({ state: 'succeeded', attempt_count: 1 });

    const ordinaryEdit = await organizationKiloPassService.updateAllocation({
      organizationId: parent.id,
      actorUserId: owner.id,
      expectedPlanVersion: 3,
      allocations: [],
    });
    expect(ordinaryEdit.nextWindowStartsAt).toBe(
      nextIssuanceBoundary(anchor, new Date()).toISOString()
    );
  });

  it('persists one parent-only supplement per provider invoice line and leaves cancellation to paid-through', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(`kpo-parent-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(parent.id);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_199',
      cadence: 'monthly',
      paidSeatCount: 1,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 1,
      firstWindow: window,
      isBridge: false,
      providerEventId: `evt_${crypto.randomUUID()}`,
    });
    const input = {
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      window,
      paidSeatCount: 2,
      providerInvoiceLineId: `il_${crypto.randomUUID()}`,
      now: new Date('2026-07-16T00:00:00.000Z'),
    };
    await createParentSupplement(input);
    await expect(createParentSupplement(input)).resolves.toEqual({ created: false });
    await expect(
      createParentSupplement({
        ...input,
        paidSeatCount: 1,
        providerInvoiceLineId: `il_${crypto.randomUUID()}`,
      })
    ).resolves.toEqual({ created: false });
    await expect(
      createParentSupplement({
        ...input,
        providerInvoiceLineId: `il_${crypto.randomUUID()}`,
      })
    ).resolves.toEqual({ created: false });
    const supplements = await db.select().from(kilo_pass_org_supplements);
    expect(supplements).toHaveLength(1);
    await expect(
      organizationKiloPassService.getDetail({ organizationId: parent.id })
    ).resolves.toMatchObject({
      currentAllocations: [expect.objectContaining({ hasProratedCredits: true })],
    });
    const plans = await db
      .select()
      .from(kilo_pass_org_allocation_plans)
      .where(eq(kilo_pass_org_allocation_plans.agreement_id, pending.agreementId));
    expect(plans).toHaveLength(1);
  });

  it('calculates supplement delta from every current-window allocation before granting parent-only', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(`kpo-parent-${crypto.randomUUID()}`, owner.id);
    const child = await createOrganization(`kpo-child-${crypto.randomUUID()}`, childOwner.id);
    organizationIds.push(parent.id, child.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 2,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 1 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 2,
      firstWindow: window,
      isBridge: false,
    });
    await expect(
      createParentSupplement({
        agreementId: pending.agreementId,
        recipientUserId: owner.id,
        window,
        paidSeatCount: 3,
        providerInvoiceLineId: `il_${crypto.randomUUID()}`,
        now: new Date('2026-07-16T00:00:00.000Z'),
      })
    ).resolves.toEqual({ created: true });
    await expect(
      createParentSupplement({
        agreementId: pending.agreementId,
        recipientUserId: owner.id,
        window,
        paidSeatCount: 2,
        providerInvoiceLineId: `il_${crypto.randomUUID()}`,
        now: new Date('2026-07-17T00:00:00.000Z'),
      })
    ).resolves.toEqual({ created: false });
    await expect(
      createParentSupplement({
        agreementId: pending.agreementId,
        recipientUserId: owner.id,
        window,
        paidSeatCount: 3,
        providerInvoiceLineId: `il_${crypto.randomUUID()}`,
        now: new Date('2026-07-18T00:00:00.000Z'),
      })
    ).resolves.toEqual({ created: false });
  });

  it('creates a parent supplement when the initial parent allocation is zero', async () => {
    const owner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createOrganization(`kpo-parent-${crypto.randomUUID()}`, owner.id);
    const child = await createOrganization(`kpo-child-${crypto.randomUUID()}`, childOwner.id);
    organizationIds.push(parent.id, child.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 1,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [{ organizationId: child.id, passCapacity: 1 }],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 1,
      firstWindow: window,
      isBridge: false,
    });

    await expect(
      createParentSupplement({
        agreementId: pending.agreementId,
        recipientUserId: owner.id,
        window,
        paidSeatCount: 2,
        providerInvoiceLineId: `il_${crypto.randomUUID()}`,
        now: new Date('2026-07-16T00:00:00.000Z'),
      })
    ).resolves.toEqual({ created: true });
    const supplements = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(eq(kilo_pass_org_issuance_snapshots.agreement_id, pending.agreementId));
    expect(
      supplements.some(
        snapshot =>
          snapshot.allocation_container_organization_id === parent.id &&
          snapshot.tranche_key.startsWith('supplement:') &&
          snapshot.allocated_pass_capacity === 1
      )
    ).toBe(true);
  });

  it('does not persist a supplement when no service remains', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(`kpo-zero-supplement-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(parent.id);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 1,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 1,
      firstWindow: window,
      isBridge: false,
    });
    const providerInvoiceLineId = `il_${crypto.randomUUID()}`;
    await expect(
      createParentSupplement({
        agreementId: pending.agreementId,
        recipientUserId: owner.id,
        window,
        paidSeatCount: 2,
        providerInvoiceLineId,
        now: window.end,
      })
    ).resolves.toEqual({ created: false });
    const supplements = await db
      .select()
      .from(kilo_pass_org_supplements)
      .where(eq(kilo_pass_org_supplements.provider_invoice_line_id, providerInvoiceLineId));
    expect(supplements).toHaveLength(0);
  });

  it('derives future boundaries from the original month-end anchor', () => {
    expect(
      nextIssuanceBoundary(
        new Date('2026-01-31T12:00:00.000Z'),
        new Date('2026-02-28T12:00:00.000Z')
      ).toISOString()
    ).toBe('2026-03-31T12:00:00.000Z');
  });

  it('replays monthly windows for an annual paid term, stops at twelve, and is replay-safe', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(`kpo-annual-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(parent.id);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'yearly',
      paidSeatCount: 1,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: new Date('2027-07-01T00:00:00.000Z'),
      paidSeatCount: 1,
      firstWindow: { start: window.start, end: new Date('2027-07-01T00:00:00.000Z') },
      isBridge: false,
    });

    const first = await runOrganizationPassIssuanceCron(db, new Date('2027-08-01T00:00:00.000Z'));
    const replay = await runOrganizationPassIssuanceCron(db, new Date('2027-08-01T00:00:00.000Z'));
    expect(first.issued).toBe(11);
    expect(replay.issued).toBe(0);
    const snapshots = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(eq(kilo_pass_org_issuance_snapshots.agreement_id, pending.agreementId));
    expect(snapshots).toHaveLength(12);
  });

  it('schedules the next monthly window once paid-through covers it', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(`kpo-monthly-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(parent.id);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 1,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: new Date('2026-09-01T00:00:00.000Z'),
      paidSeatCount: 1,
      firstWindow: window,
      isBridge: false,
    });
    await expect(
      runOrganizationPassIssuanceCron(db, new Date('2026-08-02T00:00:00.000Z'))
    ).resolves.toMatchObject({ issued: 1 });
  });

  it('does not overlap a bridged partial month with the following full issuance window', async () => {
    const owner = await insertTestUser();
    const parent = await createOrganization(`kpo-bridge-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(parent.id);
    const pending = await createPendingAgreement({
      parentOrganizationId: parent.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 1,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    const containingMonth = window;
    const paidBridgeInterval = {
      start: new Date('2026-07-15T00:00:00.000Z'),
      end: window.end,
    };
    await activatePaidAgreement({
      agreementId: pending.agreementId,
      recipientUserId: owner.id,
      paidFrom: paidBridgeInterval.start,
      paidUntil: new Date('2026-09-01T00:00:00.000Z'),
      paidSeatCount: 1,
      firstWindow: containingMonth,
      paidBridgeInterval,
      isBridge: true,
    });
    await expect(
      organizationKiloPassService.getDetail({ organizationId: parent.id })
    ).resolves.toMatchObject({
      currentAllocations: [expect.objectContaining({ hasProratedCredits: true })],
    });
    await runOrganizationPassIssuanceCron(db, new Date('2026-08-02T00:00:00.000Z'));
    const snapshots = await db
      .select({
        start: kilo_pass_org_issuance_snapshots.window_start,
        end: kilo_pass_org_issuance_snapshots.window_end,
      })
      .from(kilo_pass_org_issuance_snapshots)
      .where(eq(kilo_pass_org_issuance_snapshots.agreement_id, pending.agreementId))
      .orderBy(kilo_pass_org_issuance_snapshots.window_start);
    expect(
      snapshots.map(snapshot => [
        new Date(snapshot.start).toISOString(),
        new Date(snapshot.end).toISOString(),
      ])
    ).toEqual([
      ['2026-07-15T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
      ['2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    ]);
  });
});
