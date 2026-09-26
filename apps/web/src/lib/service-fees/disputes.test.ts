import { describe, expect, test } from '@jest/globals';

import {
  markServiceFeeAssessmentCharged,
  observeServiceFeeAssessmentRefunds,
  prepareServiceFeeAssessmentDecision,
  sanitizeServiceFeeAssessmentMetadata,
  settleServiceFeeAssessment,
  upsertServiceFeeAssessment,
  type ServiceFeeAssessmentRecord,
} from '@/lib/service-fees/assessments';
import { SERVICE_FEE_ACTIVATION_UNIX_SECONDS } from '@/lib/service-fees/constants';
import {
  observeServiceFeeDisputeClosed,
  observeServiceFeeDisputeFundsWithdrawn,
} from '@/lib/service-fees/disputes';
import {
  ServiceFeeObservationNotReadyError,
  type ServiceFeeRefundAssessmentStore,
} from '@/lib/service-fees/refunds';

const ACTIVATION = new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000);
const ASSESSMENT_KEY = 'checkout:22222222-2222-4222-8222-222222222222';
const CHARGE_ID = 'ch_dispute_1';
const PAYMENT_INTENT_ID = 'pi_dispute_1';

function cloneRecord(record: ServiceFeeAssessmentRecord): ServiceFeeAssessmentRecord {
  return { ...record, metadata: { ...record.metadata } };
}

function createMemoryStore(): ServiceFeeRefundAssessmentStore {
  const rows = new Map<string, ServiceFeeAssessmentRecord>();
  const store: ServiceFeeRefundAssessmentStore = {
    async transact(fn) {
      return fn(store);
    },
    async findByAssessmentKey(assessmentKey) {
      const row = rows.get(assessmentKey);
      return row ? cloneRecord(row) : null;
    },
    async findByStripeChargeId(stripeChargeId) {
      const row = [...rows.values()].find(candidate => candidate.stripeChargeId === stripeChargeId);
      return row ? cloneRecord(row) : null;
    },
    async findByStripePaymentIntentId(stripePaymentIntentId) {
      const row = [...rows.values()].find(
        candidate => candidate.stripePaymentIntentId === stripePaymentIntentId
      );
      return row ? cloneRecord(row) : null;
    },
    async findByStripeInvoiceId(stripeInvoiceId) {
      const row = [...rows.values()].find(
        candidate => candidate.stripeInvoiceId === stripeInvoiceId
      );
      return row ? cloneRecord(row) : null;
    },
    async insert(record) {
      if (rows.has(record.assessmentKey)) {
        throw new Error(`duplicate assessment_key ${record.assessmentKey}`);
      }
      const copy = cloneRecord(record);
      rows.set(record.assessmentKey, copy);
      return cloneRecord(copy);
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
      return cloneRecord(next);
    },
  };
  return store;
}

async function persistCharged(store: ServiceFeeRefundAssessmentStore, chargeLinked = true) {
  const decision = await prepareServiceFeeAssessmentDecision({
    assessmentKey: ASSESSMENT_KEY,
    flow: 'personal_top_up',
    currency: 'usd',
    eligibilityCreatedAt: ACTIVATION,
    eligibleSubtotalMinor: 10_000,
    kiloUserId: 'user_dispute',
  });
  await upsertServiceFeeAssessment({
    store,
    decision,
    stripeIds: {
      stripeChargeId: chargeLinked ? CHARGE_ID : null,
      stripePaymentIntentId: PAYMENT_INTENT_ID,
    },
    now: ACTIVATION,
  });
  return markServiceFeeAssessmentCharged({
    store,
    assessmentKey: ASSESSMENT_KEY,
    chargedFeeMinor: 500,
    now: ACTIVATION,
  });
}

async function persistSettled(store: ServiceFeeRefundAssessmentStore, chargeLinked = true) {
  await persistCharged(store, chargeLinked);
  await settleServiceFeeAssessment({
    store,
    assessmentKey: ASSESSMENT_KEY,
    settledAt: ACTIVATION,
    settledProductMinor: 10_000,
    grossPaidMinor: 10_500,
    chargedFeeMinor: 500,
    now: ACTIVATION,
  });
  return observeServiceFeeAssessmentRefunds({
    store,
    assessmentKey: ASSESSMENT_KEY,
    refundedProductMinor: 2_000,
    refundedFeeMinor: 100,
    refundedGrossMinor: 2_100,
    now: ACTIVATION,
  });
}

describe('observeServiceFeeDisputeFundsWithdrawn', () => {
  test('sets the charged fee without touching outcome or refunds', async () => {
    const store = createMemoryStore();
    await persistSettled(store);

    const withdrawn = await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute: {
        id: 'dp_1',
        status: 'lost',
        charge: CHARGE_ID,
        payment_intent: PAYMENT_INTENT_ID,
      },
    });

    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.assessment).toMatchObject({
      outcome: 'charged',
      disputedFeeMinor: 500,
      refundedProductMinor: 2_000,
      refundedFeeMinor: 100,
      refundedGrossMinor: 2_100,
    });

    const again = await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute: { id: 'dp_1', status: 'lost', charge: CHARGE_ID },
    });
    expect(again.status).toBe('unchanged');
    expect(again.assessment).toMatchObject({
      outcome: 'charged',
      disputedFeeMinor: 500,
      refundedProductMinor: 2_000,
      refundedFeeMinor: 100,
    });
  });

  test('out-of-order funds withdrawn before paid throws then converges after settlement', async () => {
    const store = createMemoryStore();
    await persistCharged(store);
    const dispute = {
      id: 'dp_before_paid',
      status: 'needs_response',
      charge: CHARGE_ID,
      payment_intent: PAYMENT_INTENT_ID,
    };

    await expect(observeServiceFeeDisputeFundsWithdrawn({ store, dispute })).rejects.toBeInstanceOf(
      ServiceFeeObservationNotReadyError
    );
    expect(await store.findByAssessmentKey(ASSESSMENT_KEY)).toMatchObject({
      settledAt: null,
      disputedFeeMinor: 0,
    });

    await expect(observeServiceFeeDisputeFundsWithdrawn({ store, dispute })).rejects.toBeInstanceOf(
      ServiceFeeObservationNotReadyError
    );

    await settleServiceFeeAssessment({
      store,
      assessmentKey: ASSESSMENT_KEY,
      settledAt: ACTIVATION,
      settledProductMinor: 10_000,
      grossPaidMinor: 10_500,
      chargedFeeMinor: 500,
      now: ACTIVATION,
    });

    const withdrawn = await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute,
    });
    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.assessment).toMatchObject({
      outcome: 'charged',
      disputedFeeMinor: 500,
    });

    const again = await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute,
    });
    expect(again.status).toBe('unchanged');
    expect(again.assessment).toMatchObject({
      disputedFeeMinor: 500,
    });
  });

  test('a settled zero-fee assessment has no persisted dispute consequence', async () => {
    const store = createMemoryStore();
    const decision = await prepareServiceFeeAssessmentDecision({
      assessmentKey: 'checkout:zero-fee-dispute',
      flow: 'personal_top_up',
      currency: 'usd',
      eligibilityCreatedAt: ACTIVATION,
      eligibleSubtotalMinor: 0,
      kiloUserId: 'user_zero_fee_dispute',
    });
    await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds: { stripeChargeId: 'ch_zero_fee_dispute' },
      now: ACTIVATION,
    });
    await settleServiceFeeAssessment({
      store,
      assessmentKey: decision.assessmentKey,
      settledAt: ACTIVATION,
      settledProductMinor: 0,
      grossPaidMinor: 0,
      now: ACTIVATION,
    });

    const withdrawn = await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute: { id: 'dp_zero', charge: 'ch_zero_fee_dispute' },
    });

    expect(withdrawn.status).toBe('unchanged');
    expect(withdrawn.disputedFeeMinor).toBe(0);
  });

  test('resolves the assessment by payment intent when the charge id is not linked', async () => {
    const store = createMemoryStore();
    await persistSettled(store, false);

    const withdrawn = await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute: {
        id: 'dp_pi',
        status: 'needs_response',
        charge: 'ch_other',
        payment_intent: PAYMENT_INTENT_ID,
      },
    });

    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.disputedFeeMinor).toBe(500);
  });
});

describe('observeServiceFeeDisputeClosed', () => {
  test('clears the dispute fee on won and leaves refunds and outcome untouched', async () => {
    const store = createMemoryStore();
    await persistSettled(store);
    await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute: { id: 'dp_2', charge: CHARGE_ID },
    });

    const won = await observeServiceFeeDisputeClosed({
      store,
      dispute: { id: 'dp_2', status: 'won', charge: CHARGE_ID },
    });
    expect(won.status).toBe('cleared');
    expect(won.assessment).toMatchObject({
      outcome: 'charged',
      disputedFeeMinor: 0,
      refundedProductMinor: 2_000,
      refundedFeeMinor: 100,
    });

    const wonAgain = await observeServiceFeeDisputeClosed({
      store,
      dispute: { id: 'dp_2', status: 'won', charge: CHARGE_ID },
    });
    expect(wonAgain.status).toBe('unchanged');
    expect(wonAgain.assessment).toMatchObject({
      outcome: 'charged',
      disputedFeeMinor: 0,
      refundedProductMinor: 2_000,
    });
  });

  test('does not clear the dispute fee when the closed dispute is lost', async () => {
    const store = createMemoryStore();
    await persistSettled(store);
    await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute: { id: 'dp_lost', charge: CHARGE_ID },
    });

    const lost = await observeServiceFeeDisputeClosed({
      store,
      dispute: { id: 'dp_lost', status: 'lost', charge: CHARGE_ID },
    });
    expect(lost.status).toBe('unchanged');
    expect(lost.assessment).toMatchObject({
      outcome: 'charged',
      disputedFeeMinor: 500,
      refundedFeeMinor: 100,
    });
  });

  test('ignores disputes with no matching assessment', async () => {
    const store = createMemoryStore();
    const result = await observeServiceFeeDisputeFundsWithdrawn({
      store,
      dispute: { id: 'dp_unknown', charge: 'ch_missing' },
    });
    expect(result).toEqual({
      status: 'ignored',
      assessment: null,
      disputedFeeMinor: 0,
    });
  });
});
