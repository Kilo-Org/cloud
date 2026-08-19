import { describe, expect, test } from '@jest/globals';

import {
  ServiceFeeAssessmentConflictError,
  canTransitionServiceFeeOutcome,
  linkServiceFeeAssessmentStripeIds,
  markServiceFeeAssessmentCharged,
  markServiceFeeAssessmentMissed,
  observeServiceFeeAssessmentDispute,
  observeServiceFeeAssessmentRefunds,
  prepareServiceFeeAssessmentDecision,
  sanitizeServiceFeeAssessmentMetadata,
  settleServiceFeeAssessment,
  upsertServiceFeeAssessment,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
} from '@/lib/service-fees/assessments';
import { SERVICE_FEE_ACTIVATION_UNIX_SECONDS } from '@/lib/service-fees/constants';
import type { PrepareAssessmentInput } from '@/lib/service-fees/types';

function createMemoryAssessmentStore(): ServiceFeeAssessmentStore {
  const rows = new Map<string, ServiceFeeAssessmentRecord>();

  const store: ServiceFeeAssessmentStore = {
    async transact(fn) {
      return fn(store);
    },
    async findByAssessmentKey(assessmentKey) {
      return rows.get(assessmentKey) ?? null;
    },
    async insert(record) {
      if (rows.has(record.assessmentKey)) {
        throw new Error(`duplicate assessment_key ${record.assessmentKey}`);
      }
      const copy = { ...record, metadata: { ...record.metadata } };
      rows.set(record.assessmentKey, copy);
      return { ...copy };
    },
    async update(assessmentKey, patch) {
      const existing = rows.get(assessmentKey);
      if (!existing) throw new Error(`missing ${assessmentKey}`);
      const next = {
        ...existing,
        ...patch,
        metadata:
          patch.metadata !== undefined
            ? sanitizeServiceFeeAssessmentMetadata(patch.metadata)
            : { ...existing.metadata },
      };
      rows.set(assessmentKey, next);
      return { ...next };
    },
  };

  return store;
}

const ACTIVATION = new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000);
const BEFORE_ACTIVATION = new Date((SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 1) * 1000);

function personalInput(overrides: Partial<PrepareAssessmentInput> = {}): PrepareAssessmentInput {
  return {
    assessmentKey: 'checkout:11111111-1111-4111-8111-111111111111',
    flow: 'personal_top_up',
    currency: 'usd',
    eligibilityCreatedAt: ACTIVATION,
    eligibleSubtotalMinor: 10_000,
    kiloUserId: 'user_1',
    ...overrides,
  };
}

function organizationInput(
  overrides: Partial<PrepareAssessmentInput> = {}
): PrepareAssessmentInput {
  return {
    assessmentKey: 'invoice:in_test_1',
    flow: 'organization_top_up',
    currency: 'usd',
    eligibilityCreatedAt: ACTIVATION,
    eligibleSubtotalMinor: 10_000,
    organizationId: 'org_1',
    kiloUserId: 'user_1',
    ...overrides,
  };
}

async function persistPending(
  store: ServiceFeeAssessmentStore,
  input: PrepareAssessmentInput = personalInput()
) {
  const decision = await prepareServiceFeeAssessmentDecision(input);
  return upsertServiceFeeAssessment({ store, decision });
}

describe('prepareServiceFeeAssessmentDecision', () => {
  test('validates owner and subtotal, then applies cutoff, exemption, and fee outcomes', async () => {
    await expect(
      prepareServiceFeeAssessmentDecision(personalInput({ kiloUserId: undefined }))
    ).rejects.toThrow(/requires kiloUserId/);
    await expect(
      prepareServiceFeeAssessmentDecision(personalInput({ eligibleSubtotalMinor: 1.5 }))
    ).rejects.toThrow(/safe integer/);

    const unsupported = await prepareServiceFeeAssessmentDecision(
      personalInput({ currency: 'EUR', eligibleSubtotalMinor: 10_000 })
    );
    expect(unsupported).toMatchObject({
      outcome: 'unsupported_currency',
      eligibleSubtotalMinor: 0,
      expectedFeeMinor: 0,
      chargedFeeMinor: 0,
    });

    const preActivation = await prepareServiceFeeAssessmentDecision(
      personalInput({ eligibilityCreatedAt: BEFORE_ACTIVATION })
    );
    expect(preActivation).toMatchObject({
      outcome: 'pre_activation',
      expectedFeeMinor: 500,
    });

    const exempt = await prepareServiceFeeAssessmentDecision(organizationInput(), {
      findEffectiveExemption: async () => ({ id: 'hist_1', isExempt: true }),
    });
    expect(exempt).toMatchObject({
      outcome: 'exempt',
      expectedFeeMinor: 500,
      exemptionId: 'hist_1',
    });

    const revoked = await prepareServiceFeeAssessmentDecision(organizationInput(), {
      findEffectiveExemption: async () => ({ id: 'hist_2', isExempt: false }),
    });
    expect(revoked).toMatchObject({ outcome: 'pending', exemptionId: null });

    const zeroRounded = await prepareServiceFeeAssessmentDecision(
      personalInput({ eligibleSubtotalMinor: 1 })
    );
    expect(zeroRounded).toMatchObject({
      outcome: 'zero_rounded',
      expectedFeeMinor: 0,
    });

    const pending = await prepareServiceFeeAssessmentDecision(personalInput());
    expect(pending).toMatchObject({
      outcome: 'pending',
      expectedFeeMinor: 500,
      chargedFeeMinor: 0,
    });
  });
});

describe('upsertServiceFeeAssessment', () => {
  test('is idempotent on assessment_key and enriches absent Stripe IDs', async () => {
    const store = createMemoryAssessmentStore();
    const decision = await prepareServiceFeeAssessmentDecision(personalInput());
    const first = await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds: { stripeCustomerId: 'cus_1' },
    });
    const second = await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds: {
        stripeCustomerId: 'cus_1',
        stripeCheckoutSessionId: 'cs_1',
        stripePaymentIntentId: 'pi_1',
      },
    });

    expect(second.assessmentKey).toBe(first.assessmentKey);
    expect(second.stripeCustomerId).toBe('cus_1');
    expect(second.stripeCheckoutSessionId).toBe('cs_1');
    expect(second.stripePaymentIntentId).toBe('pi_1');
    expect(second.outcome).toBe('pending');
  });

  test('rejects conflicting owner, flow, currency, subtotal, expected fee, and Stripe IDs', async () => {
    const store = createMemoryAssessmentStore();
    const decision = await prepareServiceFeeAssessmentDecision(personalInput());
    await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds: { stripeInvoiceId: 'in_1' },
    });

    await expect(
      upsertServiceFeeAssessment({
        store,
        decision: await prepareServiceFeeAssessmentDecision(
          personalInput({ kiloUserId: 'user_other' })
        ),
      })
    ).rejects.toMatchObject({ reason: 'owner', field: 'kiloUserId' });

    await expect(
      upsertServiceFeeAssessment({
        store,
        decision: {
          ...decision,
          flow: 'personal_kilo_pass',
        },
      })
    ).rejects.toMatchObject({ reason: 'flow' });

    await expect(
      upsertServiceFeeAssessment({
        store,
        decision: { ...decision, currency: 'eur' },
      })
    ).rejects.toMatchObject({ reason: 'currency' });

    await expect(
      upsertServiceFeeAssessment({
        store,
        decision: {
          ...decision,
          eligibleSubtotalMinor: 20_000,
          expectedFeeMinor: 1_000,
        },
      })
    ).rejects.toMatchObject({ reason: 'eligible_subtotal' });

    await expect(
      upsertServiceFeeAssessment({
        store,
        decision: { ...decision, expectedFeeMinor: 499 },
      })
    ).rejects.toMatchObject({ reason: 'expected_fee' });

    await expect(
      upsertServiceFeeAssessment({
        store,
        decision,
        stripeIds: { stripeInvoiceId: 'in_other' },
      })
    ).rejects.toMatchObject({ reason: 'stripe_id', field: 'stripeInvoiceId' });
  });

  test('drops raw provider payload and PII from metadata', () => {
    expect(
      sanitizeServiceFeeAssessmentMetadata({
        service_fee_rate_deviation: true,
        email: 'person@example.com',
        payload: { raw: true },
        refund_allocation_unresolved: true,
      })
    ).toEqual({
      service_fee_rate_deviation: true,
      refund_allocation_unresolved: true,
    });
  });
});

describe('service fee assessment transitions', () => {
  test('pending may become charged, missed, or a terminal omitted outcome, and those never recollect', async () => {
    expect(canTransitionServiceFeeOutcome('pending', 'charged')).toBe(true);
    expect(canTransitionServiceFeeOutcome('pending', 'missed')).toBe(true);
    expect(canTransitionServiceFeeOutcome('pending', 'exempt')).toBe(true);
    expect(canTransitionServiceFeeOutcome('missed', 'charged')).toBe(false);
    expect(canTransitionServiceFeeOutcome('exempt', 'charged')).toBe(false);
    expect(canTransitionServiceFeeOutcome('pre_activation', 'charged')).toBe(false);

    const store = createMemoryAssessmentStore();
    const pending = await persistPending(store);
    const charged = await markServiceFeeAssessmentCharged({
      store,
      assessmentKey: pending.assessmentKey,
      chargedFeeMinor: 0,
      stripeIds: { stripeCheckoutSessionId: 'cs_1' },
    });
    expect(charged.outcome).toBe('charged');
    expect(charged.chargedFeeMinor).toBe(0);

    await expect(
      markServiceFeeAssessmentMissed({
        store,
        assessmentKey: pending.assessmentKey,
        failureCode: 'fee_application_failed',
      })
    ).rejects.toBeInstanceOf(ServiceFeeAssessmentConflictError);

    const missedStore = createMemoryAssessmentStore();
    const missedPending = await persistPending(
      missedStore,
      personalInput({ assessmentKey: 'checkout:missed' })
    );
    const missed = await markServiceFeeAssessmentMissed({
      store: missedStore,
      assessmentKey: missedPending.assessmentKey,
      failureCode: 'fee_application_failed',
    });
    expect(missed).toMatchObject({
      outcome: 'missed',
      chargedFeeMinor: 0,
      failureCode: 'fee_application_failed',
    });
    await expect(
      markServiceFeeAssessmentCharged({
        store: missedStore,
        assessmentKey: missed.assessmentKey,
        chargedFeeMinor: 500,
      })
    ).rejects.toMatchObject({ reason: 'illegal_transition' });

    await expect(
      markServiceFeeAssessmentMissed({
        store: missedStore,
        assessmentKey: missed.assessmentKey,
        failureCode: '  ',
      })
    ).rejects.toMatchObject({ reason: 'invalid_failure_code' });
  });

  test('links Stripe IDs only when absent or identical', async () => {
    const store = createMemoryAssessmentStore();
    const pending = await persistPending(store);
    const linked = await linkServiceFeeAssessmentStripeIds({
      store,
      assessmentKey: pending.assessmentKey,
      stripeIds: { stripeChargeId: 'ch_1', stripePaymentIntentId: 'pi_1' },
    });
    const again = await linkServiceFeeAssessmentStripeIds({
      store,
      assessmentKey: pending.assessmentKey,
      stripeIds: { stripeChargeId: 'ch_1', stripeInvoiceId: 'in_1' },
    });

    expect(again.stripeChargeId).toBe('ch_1');
    expect(again.stripePaymentIntentId).toBe('pi_1');
    expect(again.stripeInvoiceId).toBe('in_1');
    expect(linked.assessmentKey).toBe(again.assessmentKey);

    await expect(
      linkServiceFeeAssessmentStripeIds({
        store,
        assessmentKey: pending.assessmentKey,
        stripeIds: { stripeChargeId: 'ch_other' },
      })
    ).rejects.toMatchObject({ reason: 'stripe_id' });
  });
});

describe('settleServiceFeeAssessment', () => {
  test('rejects pending and records observed product, fee, and gross idempotently', async () => {
    const store = createMemoryAssessmentStore();
    const pending = await persistPending(store);

    await expect(
      settleServiceFeeAssessment({
        store,
        assessmentKey: pending.assessmentKey,
        settledAt: '2026-09-01T01:00:00.000Z',
        settledProductMinor: 10_000,
        grossPaidMinor: 10_500,
        chargedFeeMinor: 500,
      })
    ).rejects.toMatchObject({ reason: 'pending_settlement' });

    await markServiceFeeAssessmentCharged({
      store,
      assessmentKey: pending.assessmentKey,
      chargedFeeMinor: 0,
    });

    const settled = await settleServiceFeeAssessment({
      store,
      assessmentKey: pending.assessmentKey,
      settledAt: '2026-09-01T01:00:00.000Z',
      settledProductMinor: 8_000,
      grossPaidMinor: 8_400,
      chargedFeeMinor: 400,
      stripeIds: { stripeChargeId: 'ch_1' },
    });
    expect(settled).toMatchObject({
      outcome: 'charged',
      settledProductMinor: 8_000,
      chargedFeeMinor: 400,
      grossPaidMinor: 8_400,
      stripeChargeId: 'ch_1',
      settledAt: '2026-09-01T01:00:00.000Z',
    });

    const replay = await settleServiceFeeAssessment({
      store,
      assessmentKey: pending.assessmentKey,
      settledAt: '2026-09-01T02:00:00.000Z',
      settledProductMinor: 8_000,
      grossPaidMinor: 8_400,
      chargedFeeMinor: 400,
      stripeIds: { stripeChargeId: 'ch_1', stripeInvoiceId: 'in_1' },
    });
    expect(replay.settledAt).toBe('2026-09-01T01:00:00.000Z');
    expect(replay.stripeInvoiceId).toBe('in_1');

    await expect(
      settleServiceFeeAssessment({
        store,
        assessmentKey: pending.assessmentKey,
        settledAt: '2026-09-01T01:00:00.000Z',
        settledProductMinor: 9_000,
        grossPaidMinor: 8_400,
        chargedFeeMinor: 400,
      })
    ).rejects.toMatchObject({ field: 'settledProductMinor' });
  });

  test('caps settled product at the eligible subtotal and can settle exempt or missed rows', async () => {
    const store = createMemoryAssessmentStore();
    const decision = await prepareServiceFeeAssessmentDecision(organizationInput(), {
      findEffectiveExemption: async () => ({ id: 'hist_1', isExempt: true }),
    });
    const exempt = await upsertServiceFeeAssessment({ store, decision });
    const settled = await settleServiceFeeAssessment({
      store,
      assessmentKey: exempt.assessmentKey,
      settledAt: ACTIVATION,
      settledProductMinor: 99_999,
      grossPaidMinor: 10_000,
    });
    expect(settled.settledProductMinor).toBe(10_000);
    expect(settled.chargedFeeMinor).toBe(0);
    expect(settled.outcome).toBe('exempt');
  });
});

describe('refunds and disputes', () => {
  test('refunds are monotonic and disputes are mutable without changing outcome', async () => {
    const store = createMemoryAssessmentStore();
    const pending = await persistPending(store);
    await markServiceFeeAssessmentCharged({
      store,
      assessmentKey: pending.assessmentKey,
      chargedFeeMinor: 500,
    });
    await settleServiceFeeAssessment({
      store,
      assessmentKey: pending.assessmentKey,
      settledAt: ACTIVATION,
      settledProductMinor: 10_000,
      grossPaidMinor: 10_500,
      chargedFeeMinor: 500,
    });

    const firstRefund = await observeServiceFeeAssessmentRefunds({
      store,
      assessmentKey: pending.assessmentKey,
      refundedProductMinor: 4_000,
      refundedFeeMinor: 200,
      refundedGrossMinor: 4_200,
      unresolved: true,
    });
    expect(firstRefund).toMatchObject({
      refundedProductMinor: 4_000,
      refundedFeeMinor: 200,
      refundedGrossMinor: 4_200,
      outcome: 'charged',
      metadata: { refund_allocation_unresolved: true },
    });

    const resolved = await observeServiceFeeAssessmentRefunds({
      store,
      assessmentKey: pending.assessmentKey,
      refundedProductMinor: 4_000,
      refundedFeeMinor: 200,
      refundedGrossMinor: 4_200,
      unresolved: false,
    });
    expect(resolved.metadata.refund_allocation_unresolved).toBeUndefined();

    await expect(
      observeServiceFeeAssessmentRefunds({
        store,
        assessmentKey: pending.assessmentKey,
        refundedProductMinor: 3_000,
        refundedFeeMinor: 200,
      })
    ).rejects.toMatchObject({ reason: 'non_monotonic_refund' });

    await expect(
      observeServiceFeeAssessmentRefunds({
        store,
        assessmentKey: pending.assessmentKey,
        refundedProductMinor: 10_000,
        refundedFeeMinor: 501,
      })
    ).rejects.toMatchObject({ reason: 'refund_exceeds_settled' });

    const withdrawn = await observeServiceFeeAssessmentDispute({
      store,
      assessmentKey: pending.assessmentKey,
      disputedFeeMinor: 500,
    });
    expect(withdrawn).toMatchObject({
      disputedFeeMinor: 500,
      outcome: 'charged',
      refundedFeeMinor: 200,
    });

    const won = await observeServiceFeeAssessmentDispute({
      store,
      assessmentKey: pending.assessmentKey,
      disputedFeeMinor: 0,
    });
    expect(won).toMatchObject({
      disputedFeeMinor: 0,
      outcome: 'charged',
      refundedProductMinor: 4_000,
    });
  });
});
