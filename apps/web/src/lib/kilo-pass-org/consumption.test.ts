import { afterEach, describe, expect, it } from '@jest/globals';
import {
  credit_transactions,
  kilo_pass_org_agreements,
  kilo_pass_org_audit_records,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_qualifying_spend_events,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { activatePaidAgreement, createPendingAgreement, createParentSupplement } from './service';
import { recordOrganizationConsumption } from './consumption';
import { repairExpiredOrganizationPassBonuses } from './bonus-repair';
import { processOrganizationExpirations } from '@/lib/creditExpiration';

const activeWindow = {
  start: new Date('2027-07-01T00:00:00.000Z'),
  end: new Date('2027-08-01T00:00:00.000Z'),
};

describe('organization Pass consumption', () => {
  const organizationIds: string[] = [];

  afterEach(async () => {
    const ids = organizationIds.splice(0);
    if (!ids.length) return;
    await db
      .delete(kilo_pass_org_qualifying_spend_events)
      .where(
        inArray(kilo_pass_org_qualifying_spend_events.allocation_container_organization_id, ids)
      );
    await db
      .delete(kilo_pass_org_audit_records)
      .where(eq(kilo_pass_org_audit_records.action, 'bonus_missed_after_expiry'));
    await db
      .delete(kilo_pass_org_issuance_snapshots)
      .where(inArray(kilo_pass_org_issuance_snapshots.allocation_container_organization_id, ids));
    await db
      .delete(kilo_pass_org_agreements)
      .where(inArray(kilo_pass_org_agreements.parent_organization_id, ids));
    await db.delete(credit_transactions).where(inArray(credit_transactions.organization_id, ids));
    await db.delete(organizations).where(inArray(organizations.id, ids));
  });

  async function activePass(window = activeWindow) {
    const owner = await insertTestUser();
    const organization = await createOrganization(
      `kpo-consumption-${crypto.randomUUID()}`,
      owner.id
    );
    organizationIds.push(organization.id);
    const agreement = await createPendingAgreement({
      parentOrganizationId: organization.id,
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
      agreementId: agreement.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 1,
      firstWindow: window,
      isBridge: false,
    });
    return { owner, organization, agreementId: agreement.agreementId };
  }

  it('updates normal organization usage without duplicating it into the credit ledger', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization(
      `kpo-no-agreement-${crypto.randomUUID()}`,
      owner.id
    );
    organizationIds.push(organization.id);

    const result = await db.transaction(tx =>
      recordOrganizationConsumption(tx, {
        organizationId: organization.id,
        kiloUserId: owner.id,
        amountMicrodollars: 100,
        occurredAt: '2027-07-15T12:00:00.000Z',
        source: 'ai-gateway',
        sourceId: 'usage-without-agreement',
      })
    );

    expect(result.recorded).toBe(true);
    const credits = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.organization_id, organization.id));
    expect(credits).toHaveLength(0);
    const [updated] = await db
      .select({ microdollarsUsed: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(updated.microdollarsUsed).toBe(100);
  });

  it('records a concurrent source debit once and unlocks bonus exactly at its threshold', async () => {
    const { owner, organization } = await activePass();
    const input = {
      organizationId: organization.id,
      kiloUserId: owner.id,
      amountMicrodollars: 19_000_000,
      occurredAt: '2027-07-15T12:00:00.000Z',
      source: 'ai-gateway' as const,
      sourceId: 'usage-replay-safe',
    };
    const [first, concurrent] = await Promise.all([
      db.transaction(tx => recordOrganizationConsumption(tx, input)),
      db.transaction(tx => recordOrganizationConsumption(tx, input)),
    ]);
    const replay = await db.transaction(tx => recordOrganizationConsumption(tx, input));

    expect(first.recorded).toBe(true);
    expect(concurrent.recorded).toBe(false);
    expect(replay.recorded).toBe(false);
    const credits = await db
      .select({
        amount: credit_transactions.amount_microdollars,
        category: credit_transactions.credit_category,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.organization_id, organization.id));
    expect(credits.filter(credit => credit.amount < 0)).toHaveLength(1);
    expect(credits.filter(credit => credit.category?.startsWith('kpo:bonus-unlock:'))).toHaveLength(
      1
    );
    const [snapshot] = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(
        eq(kilo_pass_org_issuance_snapshots.allocation_container_organization_id, organization.id)
      );
    expect(snapshot?.qualifying_spend_microdollars).toBe(19_000_000);
    expect(new Date(snapshot?.bonus_unlocked_at ?? 0).toISOString()).toBe(input.occurredAt);
  });

  it('does not classify consumption outside a snapshot window', async () => {
    const { owner, organization } = await activePass();
    await db.transaction(tx =>
      recordOrganizationConsumption(tx, {
        organizationId: organization.id,
        kiloUserId: owner.id,
        amountMicrodollars: 100,
        occurredAt: '2027-08-01T00:00:00.000Z',
        source: 'exa',
        sourceId: 'outside-window',
      })
    );
    const events = await db
      .select()
      .from(kilo_pass_org_qualifying_spend_events)
      .where(
        eq(
          kilo_pass_org_qualifying_spend_events.allocation_container_organization_id,
          organization.id
        )
      );
    expect(events).toHaveLength(0);
  });

  it('classifies a supplement snapshot when it is the active issued tranche', async () => {
    const { owner, organization, agreementId } = await activePass();
    await createParentSupplement({
      agreementId,
      recipientUserId: owner.id,
      window: activeWindow,
      paidSeatCount: 2,
      providerInvoiceLineId: `il_${crypto.randomUUID()}`,
      now: new Date('2027-07-15T00:00:00.000Z'),
    });
    const snapshots = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(
        eq(kilo_pass_org_issuance_snapshots.allocation_container_organization_id, organization.id)
      );
    expect(snapshots.some(snapshot => snapshot.tranche_key.startsWith('supplement:'))).toBe(true);
    await db.transaction(tx =>
      recordOrganizationConsumption(tx, {
        organizationId: organization.id,
        kiloUserId: owner.id,
        amountMicrodollars: 1,
        occurredAt: '2027-07-16T00:00:00.000Z',
        source: 'exa',
        sourceId: 'supplement-classification',
      })
    );
    const events = await db
      .select()
      .from(kilo_pass_org_qualifying_spend_events)
      .where(
        eq(
          kilo_pass_org_qualifying_spend_events.allocation_container_organization_id,
          organization.id
        )
      );
    expect(events).toHaveLength(2);
  });

  it('does not count delayed pre-supplement consumption toward a supplement bonus', async () => {
    const { owner, organization, agreementId } = await activePass();
    await createParentSupplement({
      agreementId,
      recipientUserId: owner.id,
      window: activeWindow,
      paidSeatCount: 2,
      providerInvoiceLineId: `il_${crypto.randomUUID()}`,
      now: new Date('2027-07-15T00:00:00.000Z'),
    });
    await db.transaction(tx =>
      recordOrganizationConsumption(tx, {
        organizationId: organization.id,
        kiloUserId: owner.id,
        amountMicrodollars: 19_000_000,
        occurredAt: '2027-07-14T12:00:00.000Z',
        source: 'exa',
        sourceId: `delayed-before-supplement-${crypto.randomUUID()}`,
      })
    );
    const snapshots = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(eq(kilo_pass_org_issuance_snapshots.agreement_id, agreementId));
    const supplement = snapshots.find(snapshot => snapshot.kind === 'supplement');
    if (!supplement) throw new Error('supplement snapshot was not created');
    expect(new Date(supplement.qualifying_spend_starts_at).toISOString()).toBe(
      '2027-07-15T00:00:00.000Z'
    );
    expect(supplement.qualifying_spend_microdollars).toBe(0);
  });

  it('prorates bridge snapshots against their containing agreement month and unlocks their bonus', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization(`kpo-bridge-${crypto.randomUUID()}`, owner.id);
    organizationIds.push(organization.id);
    const bridge = {
      start: new Date('2027-07-15T00:00:00.000Z'),
      end: new Date('2027-08-01T00:00:00.000Z'),
    };
    const agreement = await createPendingAgreement({
      parentOrganizationId: organization.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 1,
      issuanceAnchorAt: activeWindow.start,
      providerSubscriptionId: `sub_${crypto.randomUUID()}`,
      providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
      initialAllocations: [],
    });
    await activatePaidAgreement({
      agreementId: agreement.agreementId,
      recipientUserId: owner.id,
      paidFrom: bridge.start,
      paidUntil: bridge.end,
      paidSeatCount: 1,
      firstWindow: bridge,
      isBridge: true,
    });
    const [snapshot] = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(
        eq(kilo_pass_org_issuance_snapshots.allocation_container_organization_id, organization.id)
      );
    expect(snapshot?.kind).toBe('bridge');
    expect(snapshot?.base_credit_microdollars).toBe(Math.round((19_000_000 * 17) / 31));
    await db.transaction(tx =>
      recordOrganizationConsumption(tx, {
        organizationId: organization.id,
        kiloUserId: owner.id,
        amountMicrodollars: snapshot?.unlock_spend_microdollars ?? 0,
        occurredAt: '2027-07-20T12:00:00.000Z',
        source: 'exa',
        sourceId: `bridge-${crypto.randomUUID()}`,
      })
    );
    const [updated] = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(eq(kilo_pass_org_issuance_snapshots.id, snapshot?.id ?? ''));
    expect(updated?.bonus_unlocked_at).not.toBeNull();
  });

  it('records an expired missed unlock once without issuing spendable credit', async () => {
    const expired = {
      start: new Date('2025-05-01T00:00:00.000Z'),
      end: new Date('2025-06-01T00:00:00.000Z'),
    };
    const { owner, organization } = await activePass(expired);
    const [snapshot] = await db
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(
        eq(kilo_pass_org_issuance_snapshots.allocation_container_organization_id, organization.id)
      );
    const [source] = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: owner.id,
        organization_id: organization.id,
        amount_microdollars: -19_000_000,
        is_free: false,
        credit_category: `kpo:repair-source:${crypto.randomUUID()}`,
        check_category_uniqueness: true,
      })
      .returning({ id: credit_transactions.id });
    await db.insert(kilo_pass_org_qualifying_spend_events).values({
      issuance_snapshot_id: snapshot.id,
      allocation_container_organization_id: organization.id,
      credit_transaction_id: source.id,
      spent_microdollars: 19_000_000,
      occurred_at: '2025-05-15T12:00:00.000Z',
    });

    const first = await db.transaction(tx =>
      repairExpiredOrganizationPassBonuses(tx, '2027-07-01T00:00:00.000Z')
    );
    const replay = await db.transaction(tx =>
      repairExpiredOrganizationPassBonuses(tx, '2027-07-01T00:00:00.000Z')
    );
    expect(first.recordedMisses).toBe(1);
    expect(replay.recordedMisses).toBe(0);
    const repairs = await db
      .select()
      .from(kilo_pass_org_audit_records)
      .where(eq(kilo_pass_org_audit_records.agreement_id, snapshot.agreement_id));
    expect(repairs).toHaveLength(1);
    const bonusCredits = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.credit_category, `kpo:bonus-unlock:${snapshot.id}`));
    expect(bonusCredits).toHaveLength(0);
  });

  it('records late historical usage and an audit outcome without unlocking an expired bonus', async () => {
    const expired = {
      start: new Date('2025-05-01T00:00:00.000Z'),
      end: new Date('2025-06-01T00:00:00.000Z'),
    };
    const { owner, organization } = await activePass(expired);
    await db.transaction(tx =>
      recordOrganizationConsumption(tx, {
        organizationId: organization.id,
        kiloUserId: owner.id,
        amountMicrodollars: 19_000_000,
        occurredAt: '2025-05-15T12:00:00.000Z',
        source: 'exa',
        sourceId: `late-${crypto.randomUUID()}`,
      })
    );
    const events = await db
      .select()
      .from(kilo_pass_org_qualifying_spend_events)
      .where(
        eq(
          kilo_pass_org_qualifying_spend_events.allocation_container_organization_id,
          organization.id
        )
      );
    const audits = await db
      .select()
      .from(kilo_pass_org_audit_records)
      .where(eq(kilo_pass_org_audit_records.action, 'bonus_missed_after_expiry'));
    const bonusCredits = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.organization_id, organization.id));
    expect(events).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(
      bonusCredits.filter(credit => credit.credit_category?.startsWith('kpo:bonus-unlock:'))
    ).toHaveLength(0);
  });

  it('expires only the unused portion of an unlocked bonus at its snapshot end', async () => {
    const { owner, organization } = await activePass();
    await db.transaction(tx =>
      recordOrganizationConsumption(tx, {
        organizationId: organization.id,
        kiloUserId: owner.id,
        amountMicrodollars: 19_000_000,
        occurredAt: '2027-07-15T12:00:00.000Z',
        source: 'exa',
        sourceId: `unlock-expiring-bonus-${crypto.randomUUID()}`,
      })
    );
    await db.transaction(tx =>
      recordOrganizationConsumption(tx, {
        organizationId: organization.id,
        kiloUserId: owner.id,
        amountMicrodollars: 1_000_000,
        occurredAt: '2027-07-16T12:00:00.000Z',
        source: 'exa',
        sourceId: `partially-use-expiring-bonus-${crypto.randomUUID()}`,
      })
    );
    const credits = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.organization_id, organization.id));
    const expiringBonus = credits.find(credit =>
      credit.credit_category?.startsWith('kpo:bonus-unlock:')
    );
    if (!expiringBonus) throw new Error('unlocked bonus credit was not created');
    expect(new Date(expiringBonus.expiry_date!).toISOString()).toBe('2027-08-01T00:00:00.000Z');
    expect(expiringBonus.expiration_baseline_microdollars_used).toBe(19_000_000);
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    await processOrganizationExpirations(
      {
        id: organization.id,
        microdollars_used: org.microdollars_used,
        next_credit_expiration_at: org.next_credit_expiration_at,
        total_microdollars_acquired: org.total_microdollars_acquired,
      },
      new Date('2027-08-02T00:00:00.000Z')
    );
    const expirations = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.original_transaction_id, expiringBonus.id));
    expect(expirations).toHaveLength(1);
    expect(expirations[0].amount_microdollars).toBe(-3_000_000);
  });
});
