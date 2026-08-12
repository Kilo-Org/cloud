import { describe, expect, test, jest } from '@jest/globals';
import type Stripe from 'stripe';

import {
  markServiceFeeAssessmentCharged,
  prepareServiceFeeAssessmentDecision,
  sanitizeServiceFeeAssessmentMetadata,
  settleServiceFeeAssessment,
  upsertServiceFeeAssessment,
  type ServiceFeeAssessmentRecord,
} from '@/lib/service-fees/assessments';
import {
  SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
  SERVICE_FEE_METADATA_TYPE,
  SERVICE_FEE_RATE_BASIS_POINTS,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';
import {
  applyDeferredServiceFeeRefunds,
  buildServiceFeeRefundAllocationMetadata,
  buildUnresolvedServiceFeeRefundAllocationAlertText,
  calculateServiceFeeRefundIncrement,
  observeServiceFeeChargeRefunded,
  observeServiceFeeCreditNote,
  parseServiceFeeRefundAllocationMetadata,
  SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED,
  ServiceFeeObservationNotReadyError,
  type ServiceFeeChargeRefundObservation,
  type ServiceFeeCreditNoteObservation,
  type ServiceFeeRefundAssessmentStore,
  type ServiceFeeRefundStripeClient,
  type UnresolvedServiceFeeRefundAllocationAlertInput,
} from '@/lib/service-fees/refunds';

const ACTIVATION = new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000);
const ASSESSMENT_KEY = 'checkout:11111111-1111-4111-8111-111111111111';
const CHARGE_ID = 'ch_test_1';
const PAYMENT_INTENT_ID = 'pi_test_1';
const INVOICE_ID = 'in_test_1';
const PRODUCT_LINE_ID = 'il_product_1';
const FEE_LINE_ID = 'il_fee_1';

function cloneRecord(record: ServiceFeeAssessmentRecord): ServiceFeeAssessmentRecord {
  return { ...record, metadata: { ...record.metadata } };
}

function createMemoryRefundStore(): ServiceFeeRefundAssessmentStore {
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

async function persistChargedAssessment(
  store: ServiceFeeRefundAssessmentStore,
  stripeIds: {
    stripeChargeId?: string | null;
    stripePaymentIntentId?: string | null;
    stripeInvoiceId?: string | null;
    stripeInvoiceFeeLineItemId?: string | null;
  } = {
    stripeChargeId: CHARGE_ID,
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    stripeInvoiceId: INVOICE_ID,
    stripeInvoiceFeeLineItemId: FEE_LINE_ID,
  }
) {
  const decision = await prepareServiceFeeAssessmentDecision({
    assessmentKey: ASSESSMENT_KEY,
    flow: 'personal_top_up',
    currency: 'usd',
    eligibilityCreatedAt: ACTIVATION,
    eligibleSubtotalMinor: 10_000,
    kiloUserId: 'user_1',
  });
  await upsertServiceFeeAssessment({
    store,
    decision,
    stripeIds,
    now: ACTIVATION,
  });
  return markServiceFeeAssessmentCharged({
    store,
    assessmentKey: ASSESSMENT_KEY,
    chargedFeeMinor: 500,
    now: ACTIVATION,
  });
}

async function persistSettledAssessment(
  store: ServiceFeeRefundAssessmentStore,
  stripeIds: {
    stripeChargeId?: string | null;
    stripePaymentIntentId?: string | null;
    stripeInvoiceId?: string | null;
    stripeInvoiceFeeLineItemId?: string | null;
  } = {
    stripeChargeId: CHARGE_ID,
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    stripeInvoiceId: INVOICE_ID,
    stripeInvoiceFeeLineItemId: FEE_LINE_ID,
  }
) {
  await persistChargedAssessment(store, stripeIds);
  return settleServiceFeeAssessment({
    store,
    assessmentKey: ASSESSMENT_KEY,
    settledAt: ACTIVATION,
    settledProductMinor: 10_000,
    grossPaidMinor: 10_500,
    chargedFeeMinor: 500,
    now: ACTIVATION,
  });
}

function refund(
  overrides: Partial<Stripe.Refund> & Pick<Stripe.Refund, 'id' | 'amount'>
): Stripe.Refund {
  return {
    object: 'refund',
    balance_transaction: null,
    charge: CHARGE_ID,
    created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
    currency: 'usd',
    metadata: {},
    payment_intent: PAYMENT_INTENT_ID,
    reason: null,
    receipt_number: null,
    source_transfer_reversal: null,
    status: 'succeeded',
    transfer_reversal: null,
    ...overrides,
  } as Stripe.Refund;
}

function charge(
  overrides: Partial<ServiceFeeChargeRefundObservation> = {}
): ServiceFeeChargeRefundObservation {
  return {
    id: CHARGE_ID,
    amount: 10_500,
    amount_refunded: 10_500,
    payment_intent: PAYMENT_INTENT_ID,
    invoice: INVOICE_ID,
    refunds: { data: [], has_more: false },
    metadata: {},
    ...overrides,
  };
}

function invoiceLine(id: string, amount: number, fee: boolean): Stripe.InvoiceLineItem {
  return {
    id,
    object: 'line_item',
    amount,
    currency: 'usd',
    description: fee ? 'Service fee (5%)' : 'Credits',
    discountable: !fee,
    discount_amounts: null,
    discounts: [],
    invoice: INVOICE_ID,
    livemode: false,
    metadata: fee
      ? {
          type: SERVICE_FEE_METADATA_TYPE,
          serviceFeeVersion: SERVICE_FEE_VERSION,
          serviceFeeAssessmentKey: ASSESSMENT_KEY,
          serviceFeeRateBasisPoints: String(SERVICE_FEE_RATE_BASIS_POINTS),
        }
      : {},
    parent: null,
    period: { start: 1, end: 2 },
    pretax_credit_amounts: null,
    pricing: null,
    quantity: 1,
    subscription: null,
    taxes: null,
  } as Stripe.InvoiceLineItem;
}

function creditNoteLine(
  id: string,
  invoiceLineItem: string,
  amount: number
): Stripe.CreditNoteLineItem {
  return {
    id,
    object: 'credit_note_line_item',
    amount,
    description: null,
    discount_amount: 0,
    discount_amounts: [],
    invoice_line_item: invoiceLineItem,
    livemode: false,
    pretax_credit_amounts: [],
    quantity: 1,
    tax_rates: [],
    taxes: null,
    type: 'invoice_line_item',
    unit_amount: amount,
    unit_amount_decimal: String(amount),
  } as Stripe.CreditNoteLineItem;
}

function creditNote(params: {
  id: string;
  lines: Stripe.CreditNoteLineItem[];
  hasMore?: boolean;
  status?: Stripe.CreditNote.Status;
}): ServiceFeeCreditNoteObservation {
  return {
    id: params.id,
    invoice: INVOICE_ID,
    status: params.status ?? 'issued',
    lines: {
      object: 'list',
      data: params.lines,
      has_more: params.hasMore ?? false,
      url: `/v1/credit_notes/${params.id}/lines`,
    },
  } as ServiceFeeCreditNoteObservation;
}

function createStripeMock(
  options: {
    refundPages?: Array<{ data: Stripe.Refund[]; has_more: boolean }>;
    creditNotes?: ServiceFeeCreditNoteObservation[];
    creditNoteLinePages?: Record<
      string,
      Array<{ data: Stripe.CreditNoteLineItem[]; has_more: boolean }>
    >;
    invoiceLines?: Stripe.InvoiceLineItem[];
  } = {}
): ServiceFeeRefundStripeClient & { refunds: { list: jest.Mock; create: jest.Mock } } {
  const refundPages = options.refundPages ?? [];
  let refundPageIndex = 0;
  const listRefunds = jest.fn(async () => {
    const page = refundPages[refundPageIndex] ?? { data: [], has_more: false };
    refundPageIndex += 1;
    return page;
  });
  const createRefund = jest.fn(async () => {
    throw new Error('observe helpers must not create Stripe refunds');
  });

  return {
    refunds: {
      list: listRefunds,
      create: createRefund,
    },
    creditNotes: {
      list: jest.fn(async () => ({
        data: options.creditNotes ?? [],
        has_more: false,
      })),
      listLineItems: jest.fn(async (id: string) => {
        const pages = options.creditNoteLinePages?.[id];
        return pages?.[0] ?? { data: [], has_more: false };
      }),
    },
    invoices: {
      listLineItems: jest.fn(async () => ({
        data: options.invoiceLines ?? [
          invoiceLine(PRODUCT_LINE_ID, 10_000, false),
          invoiceLine(FEE_LINE_ID, 500, true),
        ],
        has_more: false,
      })),
    },
  };
}

describe('calculateServiceFeeRefundIncrement', () => {
  test('returns the ops-doc incremental product plus fee and finishes at the original fee', () => {
    const first = calculateServiceFeeRefundIncrement({
      originalProductMinor: 4_900,
      originalFeeMinor: 245,
      alreadyRefundedProductMinor: 0,
      alreadyRefundedFeeMinor: 0,
      additionalProductRefundMinor: 2_000,
    });
    expect(first).toEqual({
      cumulativeProductRefundMinor: 2_000,
      cumulativeFeeRefundMinor: 100,
      incrementalProductRefundMinor: 2_000,
      incrementalFeeRefundMinor: 100,
      incrementalGrossRefundMinor: 2_100,
    });

    const remainder = calculateServiceFeeRefundIncrement({
      originalProductMinor: 4_900,
      originalFeeMinor: 245,
      alreadyRefundedProductMinor: first.cumulativeProductRefundMinor,
      alreadyRefundedFeeMinor: first.cumulativeFeeRefundMinor,
      additionalProductRefundMinor: 2_900,
    });
    expect(remainder).toEqual({
      cumulativeProductRefundMinor: 4_900,
      cumulativeFeeRefundMinor: 245,
      incrementalProductRefundMinor: 2_900,
      incrementalFeeRefundMinor: 145,
      incrementalGrossRefundMinor: 3_045,
    });
  });

  test('uses half-up on the aggregate and never drifts past the remaining fee', () => {
    const increment = calculateServiceFeeRefundIncrement({
      originalProductMinor: 10_000,
      originalFeeMinor: 500,
      alreadyRefundedProductMinor: 0,
      alreadyRefundedFeeMinor: 0,
      additionalProductRefundMinor: 3_333,
    });
    expect(increment.cumulativeFeeRefundMinor).toBe(167);
    expect(increment.incrementalGrossRefundMinor).toBe(3_500);

    let alreadyProduct = 0;
    let alreadyFee = 0;
    for (let step = 0; step < 10_000; step += 1) {
      const next = calculateServiceFeeRefundIncrement({
        originalProductMinor: 10_000,
        originalFeeMinor: 500,
        alreadyRefundedProductMinor: alreadyProduct,
        alreadyRefundedFeeMinor: alreadyFee,
        additionalProductRefundMinor: 1,
      });
      expect(next.incrementalFeeRefundMinor).toBeGreaterThanOrEqual(0);
      expect(next.cumulativeFeeRefundMinor).toBeLessThanOrEqual(500);
      alreadyProduct = next.cumulativeProductRefundMinor;
      alreadyFee = next.cumulativeFeeRefundMinor;
    }
    expect(alreadyProduct).toBe(10_000);
    expect(alreadyFee).toBe(500);

    const capped = calculateServiceFeeRefundIncrement({
      originalProductMinor: 10_000,
      originalFeeMinor: 500,
      alreadyRefundedProductMinor: 10_000,
      alreadyRefundedFeeMinor: 500,
      additionalProductRefundMinor: 50,
    });
    expect(capped).toEqual({
      cumulativeProductRefundMinor: 10_000,
      cumulativeFeeRefundMinor: 500,
      incrementalProductRefundMinor: 0,
      incrementalFeeRefundMinor: 0,
      incrementalGrossRefundMinor: 0,
    });
  });
});

describe('observeServiceFeeChargeRefunded', () => {
  test('maps a no-amount full remaining refund to full product and fee', async () => {
    const store = createMemoryRefundStore();
    await persistSettledAssessment(store);
    const stripe = createStripeMock();
    const sendAlert = jest.fn(
      async (_input: UnresolvedServiceFeeRefundAllocationAlertInput) => undefined
    );

    const result = await observeServiceFeeChargeRefunded({
      store,
      charge: charge({
        amount_refunded: 10_500,
        refunds: {
          data: [refund({ id: 're_full', amount: 10_500 })],
          has_more: false,
        },
      }),
      stripe,
      deps: { sendAlert },
    });

    expect(result.status).toBe('full');
    expect(result.createdStripeRefund).toBe(false);
    expect(result.assessment).toMatchObject({
      outcome: 'charged',
      refundedProductMinor: 10_000,
      refundedFeeMinor: 500,
      refundedGrossMinor: 10_500,
      metadata: {},
    });
    expect(sendAlert).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('records unresolved metadata when credit-note lookup throws and never auto-refunds', async () => {
    const store = createMemoryRefundStore();
    await persistSettledAssessment(store);
    const stripe = createStripeMock();
    const sendAlert = jest.fn(
      async (_input: UnresolvedServiceFeeRefundAllocationAlertInput) => undefined
    );
    (stripe.creditNotes?.list as jest.Mock).mockRejectedValueOnce(new Error('stripe unavailable'));

    const result = await observeServiceFeeChargeRefunded({
      store,
      charge: charge({
        amount_refunded: 2_000,
        refunds: {
          data: [refund({ id: 're_partial_lookup_failed', amount: 2_000 })],
          has_more: false,
        },
      }),
      stripe,
      deps: { sendAlert },
    });

    expect(result.status).toBe('unresolved');
    expect(result.createdStripeRefund).toBe(false);
    expect(result.assessment).toMatchObject({
      outcome: 'charged',
      refundedProductMinor: 0,
      refundedFeeMinor: 0,
      refundedGrossMinor: 2_000,
      metadata: { refund_allocation_unresolved: true },
    });
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('records unresolved metadata and never auto-refunds an ambiguous partial charge refund', async () => {
    const store = createMemoryRefundStore();
    await persistSettledAssessment(store);
    const stripe = createStripeMock();
    const sendAlert = jest.fn(
      async (_input: UnresolvedServiceFeeRefundAllocationAlertInput) => undefined
    );

    const result = await observeServiceFeeChargeRefunded({
      store,
      charge: charge({
        amount_refunded: 2_000,
        refunds: {
          data: [refund({ id: 're_partial', amount: 2_000 })],
          has_more: false,
        },
      }),
      stripe,
      deps: { sendAlert },
    });

    expect(result.status).toBe('unresolved');
    expect(result.createdStripeRefund).toBe(false);
    expect(result.assessment).toMatchObject({
      outcome: 'charged',
      refundedProductMinor: 0,
      refundedFeeMinor: 0,
      refundedGrossMinor: 2_000,
      metadata: { refund_allocation_unresolved: true },
    });
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const alert = sendAlert.mock.calls[0]?.[0];
    expect(alert.assessmentKey).toBe(ASSESSMENT_KEY);
    expect(buildUnresolvedServiceFeeRefundAllocationAlertText(alert)).toContain(
      `failure_code=${SERVICE_FEE_REFUND_ALLOCATION_UNRESOLVED}`
    );
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('applies a supplied trusted Kilo allocation on a partial refund', async () => {
    const store = createMemoryRefundStore();
    await persistSettledAssessment(store);
    const stripe = createStripeMock();

    const result = await observeServiceFeeChargeRefunded({
      store,
      charge: charge({
        amount_refunded: 2_100,
        refunds: {
          data: [refund({ id: 're_kilo', amount: 2_100 })],
          has_more: false,
        },
      }),
      stripe,
      trustedAllocation: { productMinor: 2_000, feeMinor: 100 },
    });

    expect(result.status).toBe('allocated');
    expect(result.assessment).toMatchObject({
      refundedProductMinor: 2_000,
      refundedFeeMinor: 100,
      refundedGrossMinor: 2_100,
      metadata: {},
    });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('paginates an incomplete refund list before trusting Kilo refund metadata', async () => {
    const store = createMemoryRefundStore();
    await persistSettledAssessment(store);
    const first = refund({
      id: 're_page_1',
      amount: 2_100,
      metadata: buildServiceFeeRefundAllocationMetadata({ productMinor: 2_000, feeMinor: 100 }),
    });
    const second = refund({
      id: 're_page_2',
      amount: 2_100,
      metadata: buildServiceFeeRefundAllocationMetadata({ productMinor: 2_000, feeMinor: 100 }),
    });
    const stripe = createStripeMock({
      refundPages: [
        { data: [first], has_more: true },
        { data: [second], has_more: false },
      ],
    });

    const result = await observeServiceFeeChargeRefunded({
      store,
      charge: charge({
        amount_refunded: 4_200,
        refunds: { data: [first], has_more: true },
      }),
      stripe,
    });

    expect(stripe.refunds.list).toHaveBeenCalledTimes(2);
    expect(stripe.refunds.list).toHaveBeenNthCalledWith(1, {
      charge: CHARGE_ID,
      limit: 100,
    });
    expect(stripe.refunds.list).toHaveBeenNthCalledWith(2, {
      charge: CHARGE_ID,
      limit: 100,
      starting_after: 're_page_1',
    });
    expect(result.status).toBe('allocated');
    expect(result.assessment).toMatchObject({
      refundedProductMinor: 4_000,
      refundedFeeMinor: 200,
      refundedGrossMinor: 4_200,
    });
    expect(parseServiceFeeRefundAllocationMetadata(first.metadata)).toEqual({
      productMinor: 2_000,
      feeMinor: 100,
    });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('resolves the assessment by payment intent or invoice when charge id is not yet linked', async () => {
    const byPaymentIntent = createMemoryRefundStore();
    await persistSettledAssessment(byPaymentIntent, {
      stripeChargeId: null,
      stripePaymentIntentId: PAYMENT_INTENT_ID,
      stripeInvoiceId: null,
    });
    const piResult = await observeServiceFeeChargeRefunded({
      store: byPaymentIntent,
      charge: charge({
        id: 'ch_unlinked',
        invoice: null,
        amount_refunded: 10_500,
        refunds: { data: [refund({ id: 're_pi', amount: 10_500 })], has_more: false },
      }),
    });
    expect(piResult.status).toBe('full');
    expect(piResult.assessment?.assessmentKey).toBe(ASSESSMENT_KEY);

    const byInvoice = createMemoryRefundStore();
    await persistSettledAssessment(byInvoice, {
      stripeChargeId: null,
      stripePaymentIntentId: null,
      stripeInvoiceId: INVOICE_ID,
      stripeInvoiceFeeLineItemId: FEE_LINE_ID,
    });
    const invoiceResult = await observeServiceFeeChargeRefunded({
      store: byInvoice,
      charge: charge({
        id: 'ch_invoice_only',
        payment_intent: null,
        amount_refunded: 10_500,
        refunds: { data: [refund({ id: 're_in', amount: 10_500 })], has_more: false },
      }),
    });
    expect(invoiceResult.status).toBe('full');
    expect(invoiceResult.assessment?.refundedFeeMinor).toBe(500);
  });

  test('uses credit-note line allocation to resolve a previously unresolved partial refund', async () => {
    const store = createMemoryRefundStore();
    await persistSettledAssessment(store);
    const sendAlert = jest.fn(
      async (_input: UnresolvedServiceFeeRefundAllocationAlertInput) => undefined
    );
    const note = creditNote({
      id: 'cn_1',
      lines: [
        creditNoteLine('cnli_product', PRODUCT_LINE_ID, 2_000),
        creditNoteLine('cnli_fee', FEE_LINE_ID, 100),
      ],
    });
    const stripe = createStripeMock({
      creditNotes: [note],
      invoiceLines: [
        invoiceLine(PRODUCT_LINE_ID, 10_000, false),
        invoiceLine(FEE_LINE_ID, 500, true),
      ],
    });

    const unresolved = await observeServiceFeeChargeRefunded({
      store,
      charge: charge({
        amount_refunded: 2_100,
        refunds: { data: [refund({ id: 're_open', amount: 2_100 })], has_more: false },
      }),
      deps: { sendAlert },
    });
    expect(unresolved.status).toBe('unresolved');
    expect(unresolved.assessment?.metadata.refund_allocation_unresolved).toBe(true);

    const allocated = await observeServiceFeeCreditNote({
      store,
      creditNote: note,
      stripe,
    });
    expect(allocated.status).toBe('allocated');
    expect(allocated.createdStripeRefund).toBe(false);
    expect(allocated.assessment).toMatchObject({
      refundedProductMinor: 2_000,
      refundedFeeMinor: 100,
      refundedGrossMinor: 2_100,
      metadata: {},
    });

    const retry = await observeServiceFeeCreditNote({
      store,
      creditNote: note,
      stripe,
    });
    expect(retry.assessment).toMatchObject({
      refundedProductMinor: 2_000,
      refundedFeeMinor: 100,
    });
  });

  test('ignores refunds with no matching assessment', async () => {
    const store = createMemoryRefundStore();
    const result = await observeServiceFeeChargeRefunded({
      store,
      charge: charge({
        amount_refunded: 10_500,
        refunds: { data: [refund({ id: 're_unknown', amount: 10_500 })], has_more: false },
      }),
    });
    expect(result).toEqual({
      status: 'ignored',
      assessment: null,
      refundedGrossMinor: 10_500,
      refundedProductMinor: 0,
      refundedFeeMinor: 0,
      createdStripeRefund: false,
    });
  });

  test('out-of-order full refund before paid persists gross and converges after settlement', async () => {
    const store = createMemoryRefundStore();
    await persistChargedAssessment(store);
    const fullCharge = charge({
      amount_refunded: 10_500,
      refunds: { data: [refund({ id: 're_before_paid', amount: 10_500 })], has_more: false },
    });

    await expect(
      observeServiceFeeChargeRefunded({
        store,
        charge: fullCharge,
      })
    ).rejects.toBeInstanceOf(ServiceFeeObservationNotReadyError);

    const pending = await store.findByAssessmentKey(ASSESSMENT_KEY);
    expect(pending).toMatchObject({
      settledAt: null,
      refundedGrossMinor: 10_500,
      refundedProductMinor: 0,
      refundedFeeMinor: 0,
      outcome: 'charged',
    });

    await expect(
      observeServiceFeeChargeRefunded({
        store,
        charge: fullCharge,
      })
    ).rejects.toBeInstanceOf(ServiceFeeObservationNotReadyError);
    expect(await store.findByAssessmentKey(ASSESSMENT_KEY)).toMatchObject({
      refundedGrossMinor: 10_500,
      refundedProductMinor: 0,
      refundedFeeMinor: 0,
    });

    const settled = await settleServiceFeeAssessment({
      store,
      assessmentKey: ASSESSMENT_KEY,
      settledAt: ACTIVATION,
      settledProductMinor: 10_000,
      grossPaidMinor: 10_500,
      chargedFeeMinor: 500,
      now: ACTIVATION,
    });
    const applied = await applyDeferredServiceFeeRefunds({
      store,
      assessment: settled,
    });
    expect(applied).toMatchObject({
      refundedProductMinor: 10_000,
      refundedFeeMinor: 500,
      refundedGrossMinor: 10_500,
      outcome: 'charged',
    });

    const replay = await observeServiceFeeChargeRefunded({
      store,
      charge: fullCharge,
    });
    expect(replay.status).toBe('full');
    expect(replay.createdStripeRefund).toBe(false);
    expect(replay.assessment).toMatchObject({
      refundedProductMinor: 10_000,
      refundedFeeMinor: 500,
      refundedGrossMinor: 10_500,
    });
  });

  test('throws for a credit note that arrives before settlement so Stripe retries', async () => {
    const store = createMemoryRefundStore();
    await persistChargedAssessment(store);
    const note = creditNote({
      id: 'cn_before_paid',
      lines: [
        creditNoteLine('cnli_product', PRODUCT_LINE_ID, 2_000),
        creditNoteLine('cnli_fee', FEE_LINE_ID, 100),
      ],
    });

    await expect(
      observeServiceFeeCreditNote({
        store,
        creditNote: note,
      })
    ).rejects.toBeInstanceOf(ServiceFeeObservationNotReadyError);
    expect(await store.findByAssessmentKey(ASSESSMENT_KEY)).toMatchObject({
      settledAt: null,
      refundedProductMinor: 0,
      refundedFeeMinor: 0,
    });
  });

  test('accumulates known credit-note line allocations across notes without drift', async () => {
    const store = createMemoryRefundStore();
    await persistSettledAssessment(store);
    const first = creditNote({
      id: 'cn_a',
      lines: [
        creditNoteLine('cnli_a_product', PRODUCT_LINE_ID, 2_000),
        creditNoteLine('cnli_a_fee', FEE_LINE_ID, 100),
      ],
    });
    const second = creditNote({
      id: 'cn_b',
      lines: [
        creditNoteLine('cnli_b_product', PRODUCT_LINE_ID, 8_000),
        creditNoteLine('cnli_b_fee', FEE_LINE_ID, 400),
      ],
    });
    const stripe = createStripeMock({
      creditNotes: [first, second],
      invoiceLines: [
        invoiceLine(PRODUCT_LINE_ID, 10_000, false),
        invoiceLine(FEE_LINE_ID, 500, true),
      ],
    });

    await observeServiceFeeCreditNote({ store, creditNote: first, stripe });
    const afterSecond = await observeServiceFeeCreditNote({ store, creditNote: second, stripe });
    expect(afterSecond.assessment).toMatchObject({
      refundedProductMinor: 10_000,
      refundedFeeMinor: 500,
      outcome: 'charged',
    });

    const retry = await observeServiceFeeCreditNote({ store, creditNote: second, stripe });
    expect(retry.assessment).toMatchObject({
      refundedProductMinor: 10_000,
      refundedFeeMinor: 500,
    });
  });
});
