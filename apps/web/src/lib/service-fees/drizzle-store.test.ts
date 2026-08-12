import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  organization_service_fee_exemption_history,
  organization_service_fee_exemptions,
  organizations,
  stripe_service_fee_assessments,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

import {
  linkServiceFeeAssessmentStripeIds,
  markServiceFeeAssessmentCharged,
  markServiceFeeAssessmentMissed,
  observeServiceFeeAssessmentDispute,
  observeServiceFeeAssessmentRefunds,
  prepareServiceFeeAssessmentDecision,
  settleServiceFeeAssessment,
  upsertServiceFeeAssessment,
} from '@/lib/service-fees/assessments';
import {
  SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';
import {
  ServiceFeeAssessmentKeyConflictError,
  createOrganizationServiceFeeExemptionStore,
  createServiceFeeAssessmentStore,
  createServiceFeeStores,
} from '@/lib/service-fees/drizzle-store';
import {
  getEffectiveOrganizationServiceFeeExemption,
  getOrganizationServiceFeeExemption,
  organizationServiceFeeExemptionLockKey,
  setOrganizationServiceFeeExemption,
} from '@/lib/service-fees/organization-exemptions';
import type { PrepareAssessmentInput } from '@/lib/service-fees/types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';

const ACTIVATION = new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000);

beforeEach(async () => {
  await cleanupDbForTest();
});

describe('drizzle service fee assessment store', () => {
  test('inserts once, enriches Stripe IDs on retry, and rejects conflicts through domain functions', async () => {
    const user = await insertTestUser();
    const { assessments } = createServiceFeeStores(db);
    const assessmentKey = `checkout:${crypto.randomUUID()}`;
    const decision = await prepareServiceFeeAssessmentDecision(
      personalInput(user.id, { assessmentKey })
    );

    const [first, second] = await Promise.all([
      upsertServiceFeeAssessment({
        store: assessments,
        decision,
        stripeIds: { stripeCheckoutSessionId: 'cs_enrich_1' },
      }),
      upsertServiceFeeAssessment({
        store: assessments,
        decision,
        stripeIds: { stripePaymentIntentId: 'pi_enrich_1' },
      }),
    ]);

    expect(first.id).toBe(second.id);
    const persisted = await assessments.findByAssessmentKey(assessmentKey);
    expect(persisted).toMatchObject({
      id: first.id,
      assessmentKey,
      outcome: 'pending',
      expectedFeeMinor: 500,
      chargedFeeMinor: 0,
      stripeCheckoutSessionId: 'cs_enrich_1',
      stripePaymentIntentId: 'pi_enrich_1',
    });
    expect(await assessments.findByStripeCheckoutSessionId('cs_enrich_1')).toMatchObject({
      assessmentKey,
    });
    expect(await assessments.findByStripePaymentIntentId('pi_enrich_1')).toMatchObject({
      assessmentKey,
    });

    const linked = await linkServiceFeeAssessmentStripeIds({
      store: assessments,
      assessmentKey,
      stripeIds: {
        stripeInvoiceId: 'in_enrich_1',
        stripeChargeId: 'ch_enrich_1',
      },
    });
    expect(linked).toMatchObject({
      stripeInvoiceId: 'in_enrich_1',
      stripeChargeId: 'ch_enrich_1',
    });
    expect(await assessments.findByStripeInvoiceId('in_enrich_1')).toMatchObject({ assessmentKey });
    expect(await assessments.findByStripeChargeId('ch_enrich_1')).toMatchObject({ assessmentKey });

    await expect(
      upsertServiceFeeAssessment({
        store: assessments,
        decision: await prepareServiceFeeAssessmentDecision(
          personalInput(user.id, { assessmentKey, kiloUserId: (await insertTestUser()).id })
        ),
      })
    ).rejects.toMatchObject({ reason: 'owner', field: 'kiloUserId' });

    await expect(
      linkServiceFeeAssessmentStripeIds({
        store: assessments,
        assessmentKey,
        stripeIds: { stripeChargeId: 'ch_other' },
      })
    ).rejects.toMatchObject({ reason: 'stripe_id', field: 'stripeChargeId' });

    const charged = await markServiceFeeAssessmentCharged({
      store: assessments,
      assessmentKey,
      chargedFeeMinor: 400,
      stripeIds: { stripeCheckoutFeeLineItemId: 'li_fee_discounted' },
    });
    expect(charged).toMatchObject({
      outcome: 'charged',
      expectedFeeMinor: 500,
      chargedFeeMinor: 400,
    });

    const settled = await settleServiceFeeAssessment({
      store: assessments,
      assessmentKey,
      settledAt: '2026-09-01T01:00:00.000Z',
      settledProductMinor: 8_000,
      grossPaidMinor: 8_400,
      chargedFeeMinor: 400,
    });
    const refunded = await observeServiceFeeAssessmentRefunds({
      store: assessments,
      assessmentKey,
      refundedProductMinor: 2_000,
      refundedFeeMinor: 100,
      refundedGrossMinor: 2_100,
    });
    const disputed = await observeServiceFeeAssessmentDispute({
      store: assessments,
      assessmentKey,
      disputedProductMinor: 1_000,
      disputedFeeMinor: 50,
    });

    expect(settled.settledAt).toBe('2026-09-01T01:00:00.000Z');
    expect(refunded).toMatchObject({
      refundedProductMinor: 2_000,
      refundedFeeMinor: 100,
      outcome: 'charged',
    });
    expect(disputed).toMatchObject({
      disputedProductMinor: 1_000,
      disputedFeeMinor: 50,
      outcome: 'charged',
    });
  });

  test('surfaces assessment_key duplicates without aborting the surrounding transaction', async () => {
    const user = await insertTestUser();
    const assessmentKey = `checkout:${crypto.randomUUID()}`;
    const decision = await prepareServiceFeeAssessmentDecision(
      personalInput(user.id, { assessmentKey })
    );
    const first = await upsertServiceFeeAssessment({
      store: createServiceFeeAssessmentStore(db),
      decision,
    });

    await db.transaction(async tx => {
      const store = createServiceFeeAssessmentStore(tx);
      await expect(store.insert(first)).rejects.toBeInstanceOf(
        ServiceFeeAssessmentKeyConflictError
      );
      const found = await store.findByAssessmentKey(assessmentKey);
      expect(found?.id).toBe(first.id);
      const enriched = await store.update(assessmentKey, {
        stripeCustomerId: 'cus_after_conflict',
        updatedAt: new Date().toISOString(),
      });
      expect(enriched.stripeCustomerId).toBe('cus_after_conflict');
    });

    expect(
      await createServiceFeeAssessmentStore(db).findByAssessmentKey(assessmentKey)
    ).toMatchObject({
      id: first.id,
      stripeCustomerId: 'cus_after_conflict',
    });
  });

  test('allows charged fee below expected fee and rejects missed rows without a failure code', async () => {
    const user = await insertTestUser();
    const assessments = createServiceFeeAssessmentStore(db);
    const discountedKey = `checkout:${crypto.randomUUID()}`;
    const decision = await prepareServiceFeeAssessmentDecision(
      personalInput(user.id, { assessmentKey: discountedKey })
    );
    await upsertServiceFeeAssessment({ store: assessments, decision });
    const charged = await markServiceFeeAssessmentCharged({
      store: assessments,
      assessmentKey: discountedKey,
      chargedFeeMinor: 196,
      stripeIds: { stripeCheckoutFeeLineItemId: `li_fee_${crypto.randomUUID()}` },
    });
    expect(charged.expectedFeeMinor).toBe(500);
    expect(charged.chargedFeeMinor).toBe(196);

    const rawRows = await db
      .select()
      .from(stripe_service_fee_assessments)
      .where(eq(stripe_service_fee_assessments.assessment_key, discountedKey));
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]?.charged_fee_minor).toBe(196);
    expect(rawRows[0]?.expected_fee_minor).toBe(500);

    const missedPending = await upsertServiceFeeAssessment({
      store: assessments,
      decision: await prepareServiceFeeAssessmentDecision(
        personalInput(user.id, { assessmentKey: `checkout:${crypto.randomUUID()}` })
      ),
    });
    const missed = await markServiceFeeAssessmentMissed({
      store: assessments,
      assessmentKey: missedPending.assessmentKey,
      failureCode: 'fee_application_failed',
    });
    expect(missed).toMatchObject({
      outcome: 'missed',
      chargedFeeMinor: 0,
      failureCode: 'fee_application_failed',
    });

    const invalidMissedKey = `checkout:${crypto.randomUUID()}`;
    let missedWithoutCode: unknown;
    try {
      await db.insert(stripe_service_fee_assessments).values({
        assessment_key: invalidMissedKey,
        version: SERVICE_FEE_VERSION,
        flow: 'personal_top_up',
        eligibility: 'eligible',
        outcome: 'missed',
        currency: 'usd',
        kilo_user_id: user.id,
        eligibility_created_at: ACTIVATION.toISOString(),
        eligible_subtotal_minor: 10_000,
        expected_fee_minor: 500,
        charged_fee_minor: 0,
        failure_code: null,
      });
    } catch (error) {
      missedWithoutCode = error;
    }
    expectPostgresCheck(missedWithoutCode, 'stripe_service_fee_assessments_missed_check');

    let missedZeroExpected: unknown;
    try {
      await db.insert(stripe_service_fee_assessments).values({
        assessment_key: `checkout:${crypto.randomUUID()}`,
        version: SERVICE_FEE_VERSION,
        flow: 'personal_top_up',
        eligibility: 'eligible',
        outcome: 'missed',
        currency: 'usd',
        kilo_user_id: user.id,
        eligibility_created_at: ACTIVATION.toISOString(),
        eligible_subtotal_minor: 1,
        expected_fee_minor: 0,
        charged_fee_minor: 0,
        failure_code: 'fee_application_failed',
      });
    } catch (error) {
      missedZeroExpected = error;
    }
    expectPostgresCheck(missedZeroExpected, 'stripe_service_fee_assessments_missed_check');
  });
});

describe('drizzle organization service fee exemption store', () => {
  test('resolves exact-organization history and does not inherit a parent exemption', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const parent = await createOrganization(`Parent ${crypto.randomUUID()}`, admin.id);
    const child = await createOrganization(`Child ${crypto.randomUUID()}`, admin.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));

    const exemptions = createOrganizationServiceFeeExemptionStore(db);
    const assessments = createServiceFeeAssessmentStore(db);

    await setOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: parent.id,
      isExempt: true,
      reason: 'parent nonprofit grant',
      changedByKiloUserId: admin.id,
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    await setOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: child.id,
      isExempt: true,
      reason: 'child historical grant',
      changedByKiloUserId: admin.id,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });
    await setOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: child.id,
      isExempt: false,
      reason: 'child exemption revoked',
      changedByKiloUserId: admin.id,
      now: new Date('2026-10-01T00:00:00.000Z'),
    });

    const childView = await getOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: child.id,
    });
    expect(childView.current).toMatchObject({
      organizationId: child.id,
      isExempt: false,
      reason: 'child exemption revoked',
    });
    expect(childView.history.map(row => row.reason)).toEqual([
      'child exemption revoked',
      'child historical grant',
    ]);
    expect(childView.current?.createdAt).toBe(childView.history.at(-1)?.createdAt);

    const childAtGrant = await getEffectiveOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: child.id,
      at: new Date('2026-09-01T00:00:00.000Z'),
    });
    const childAtRevoke = await getEffectiveOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: child.id,
      at: new Date('2026-10-01T00:00:00.000Z'),
    });
    const parentNow = await getEffectiveOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: parent.id,
      at: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(childAtGrant).toMatchObject({ isExempt: true, reason: 'child historical grant' });
    expect(childAtRevoke).toMatchObject({ isExempt: false, reason: 'child exemption revoked' });
    expect(parentNow).toMatchObject({ isExempt: true, reason: 'parent nonprofit grant' });

    const sibling = await createOrganization(`Sibling ${crypto.randomUUID()}`, admin.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, sibling.id));
    const siblingEffective = await getEffectiveOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: sibling.id,
      at: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(siblingEffective).toBeNull();

    const childDecision = await prepareServiceFeeAssessmentDecision(
      organizationInput(child.id, admin.id, {
        assessmentKey: `invoice:${crypto.randomUUID()}`,
        eligibilityCreatedAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
      {
        findEffectiveExemption: async (organizationId, at) => {
          const row = await getEffectiveOrganizationServiceFeeExemption({
            store: exemptions,
            organizationId,
            at,
          });
          return row ? { id: row.id, isExempt: row.isExempt } : null;
        },
      }
    );
    expect(childDecision).toMatchObject({
      eligibility: 'exempt',
      outcome: 'exempt',
      exemptionHistoryId: childAtGrant?.id,
    });

    const siblingDecision = await prepareServiceFeeAssessmentDecision(
      organizationInput(sibling.id, admin.id, {
        assessmentKey: `invoice:${crypto.randomUUID()}`,
      }),
      {
        findEffectiveExemption: async (organizationId, at) => {
          const row = await getEffectiveOrganizationServiceFeeExemption({
            store: exemptions,
            organizationId,
            at,
          });
          return row ? { id: row.id, isExempt: row.isExempt } : null;
        },
      }
    );
    expect(siblingDecision).toMatchObject({
      eligibility: 'eligible',
      outcome: 'pending',
      exemptionHistoryId: null,
    });

    const persistedExempt = await upsertServiceFeeAssessment({
      store: assessments,
      decision: childDecision,
    });
    expect(persistedExempt.exemptionHistoryId).toBe(childAtGrant?.id);

    const historyRows = await db
      .select()
      .from(organization_service_fee_exemption_history)
      .where(eq(organization_service_fee_exemption_history.organization_id, child.id));
    const currentRows = await db
      .select()
      .from(organization_service_fee_exemptions)
      .where(eq(organization_service_fee_exemptions.organization_id, child.id));
    expect(historyRows).toHaveLength(2);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0]?.current_history_id).toBe(childView.current?.currentHistoryId);
  });

  test('rejects deleted organizations and holds a transaction-scoped advisory lock', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await createOrganization(`Deleted ${crypto.randomUUID()}`, admin.id);
    const exemptions = createOrganizationServiceFeeExemptionStore(db);

    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));

    await expect(
      setOrganizationServiceFeeExemption({
        store: exemptions,
        organizationId: organization.id,
        isExempt: true,
        reason: 'should not persist',
        changedByKiloUserId: admin.id,
      })
    ).rejects.toMatchObject({ code: 'organization_not_found' });

    const view = await getOrganizationServiceFeeExemption({
      store: exemptions,
      organizationId: organization.id,
    });
    expect(view.current).toBeNull();
    expect(view.history).toEqual([]);
    expect(await exemptions.findActiveOrganization(organization.id)).toBeNull();

    const active = await createOrganization(`Active ${crypto.randomUUID()}`, admin.id);
    await db.transaction(async tx => {
      const txStore = createOrganizationServiceFeeExemptionStore(tx);
      await txStore.lockOrganization(active.id);
      const result = await db.execute<{ locked: boolean }>(
        sql`SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${organizationServiceFeeExemptionLockKey(active.id)}, 0)) AS locked`
      );
      expect(result.rows[0]?.locked).toBe(false);

      await setOrganizationServiceFeeExemption({
        store: txStore,
        organizationId: active.id,
        isExempt: true,
        reason: 'locked grant',
        changedByKiloUserId: admin.id,
      });
    });

    const granted = await getOrganizationServiceFeeExemption({
      store: createOrganizationServiceFeeExemptionStore(db),
      organizationId: active.id,
    });
    expect(granted.current?.isExempt).toBe(true);
    expect(granted.history).toHaveLength(1);
  });
});

function personalInput(
  kiloUserId: string,
  overrides: Partial<PrepareAssessmentInput> = {}
): PrepareAssessmentInput {
  return {
    assessmentKey: `checkout:${crypto.randomUUID()}`,
    flow: 'personal_top_up',
    currency: 'usd',
    eligibilityCreatedAt: ACTIVATION,
    eligibleSubtotalMinor: 10_000,
    kiloUserId,
    ...overrides,
  };
}

function organizationInput(
  organizationId: string,
  kiloUserId: string,
  overrides: Partial<PrepareAssessmentInput> = {}
): PrepareAssessmentInput {
  return {
    assessmentKey: `invoice:${crypto.randomUUID()}`,
    flow: 'organization_top_up',
    currency: 'usd',
    eligibilityCreatedAt: ACTIVATION,
    eligibleSubtotalMinor: 10_000,
    organizationId,
    kiloUserId,
    ...overrides,
  };
}

function expectPostgresCheck(error: unknown, constraint: string): void {
  const err = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const code = err?.code ?? err?.cause?.code;
  const name = err?.constraint ?? err?.cause?.constraint;
  expect(code).toBe('23514');
  expect(name).toBe(constraint);
}
