import { describe, expect, test, jest } from '@jest/globals';
import type Stripe from 'stripe';

import { getKnownStripePriceIdsForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import {
  markServiceFeeAssessmentCharged,
  prepareServiceFeeAssessmentDecision,
  sanitizeServiceFeeAssessmentMetadata,
  upsertServiceFeeAssessment,
  type ServiceFeeAssessmentRecord,
} from '@/lib/service-fees/assessments';
import { calculateServiceFeeMinor } from '@/lib/service-fees/calculation';
import { createInvoiceServiceFeeAssessmentKey } from '@/lib/service-fees/checkout';
import { SERVICE_FEE_ACTIVATION_UNIX_SECONDS } from '@/lib/service-fees/constants';
import {
  settleKiloPassInvoiceServiceFee,
  SERVICE_FEE_FAILURE_RATE_DEVIATION,
  type KiloPassServiceFeeSettlementDependencies,
  type ServiceFeeSettlementStore,
} from '@/lib/service-fees/settlement';
import { buildServiceFeeLineMetadata } from '@/lib/service-fees/stripe-lines';

const KILO_PASS_PRICE_ID = getKnownStripePriceIdsForKiloPass()[0]!;
const ACTIVATION = SERVICE_FEE_ACTIVATION_UNIX_SECONDS;

function createMemorySettlementStore(): ServiceFeeSettlementStore {
  const rows = new Map<string, ServiceFeeAssessmentRecord>();
  const store: ServiceFeeSettlementStore = {
    async transact(fn) {
      return fn(store);
    },
    async findByAssessmentKey(assessmentKey) {
      const row = rows.get(assessmentKey);
      return row ? { ...row, metadata: { ...row.metadata } } : null;
    },
    async findByStripeInvoiceId(stripeInvoiceId) {
      const row = [...rows.values()].find(
        candidate => candidate.stripeInvoiceId === stripeInvoiceId
      );
      return row ? { ...row, metadata: { ...row.metadata } } : null;
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

function invoiceLine(
  overrides: Partial<Stripe.InvoiceLineItem> & {
    amount?: number;
    metadata?: Stripe.Metadata;
    pricing?: Stripe.InvoiceLineItem['pricing'];
    pretax_credit_amounts?: Stripe.InvoiceLineItem['pretax_credit_amounts'];
  }
): Stripe.InvoiceLineItem {
  return {
    id: overrides.id ?? 'il_test',
    object: 'line_item',
    amount: overrides.amount ?? 4_900,
    currency: 'usd',
    description: 'line',
    discountable: true,
    discount_amounts: null,
    discounts: [],
    invoice: 'in_paid',
    livemode: false,
    metadata: overrides.metadata ?? {},
    parent: null,
    period: { start: 1, end: 2 },
    pretax_credit_amounts: overrides.pretax_credit_amounts ?? null,
    pricing: overrides.pricing ?? null,
    quantity: 1,
    subscription: null,
    taxes: null,
    ...overrides,
  } as Stripe.InvoiceLineItem;
}

function pricedLine(
  priceId: string,
  amount: number,
  extra: Partial<Parameters<typeof invoiceLine>[0]> = {}
) {
  return invoiceLine({
    amount,
    pricing: {
      type: 'price_details',
      unit_amount_decimal: String(amount),
      price_details: { price: priceId, product: 'prod_pass' },
    },
    ...extra,
  });
}

function feeLine(
  assessmentKey: string,
  amount: number,
  extra: Partial<Stripe.InvoiceLineItem> = {}
) {
  return invoiceLine({
    id: extra.id ?? 'il_fee',
    amount,
    metadata: buildServiceFeeLineMetadata(assessmentKey),
    pretax_credit_amounts: extra.pretax_credit_amounts ?? null,
    ...extra,
  });
}

function paidInvoice(
  lines: Stripe.InvoiceLineItem[],
  overrides: Partial<Stripe.Invoice> & { has_more?: boolean } = {}
): Stripe.Invoice {
  const { has_more, metadata, amount_paid, id, ...invoiceOverrides } = overrides;
  return {
    id: id ?? 'in_paid',
    object: 'invoice',
    created: ACTIVATION,
    status: 'paid',
    currency: 'usd',
    customer: 'cus_1',
    amount_paid: amount_paid ?? 5_145,
    status_transitions: {
      finalized_at: ACTIVATION,
      marked_uncollectible_at: null,
      paid_at: ACTIVATION + 10,
      voided_at: null,
    },
    payments: {
      object: 'list',
      has_more: false,
      url: '/v1/invoices/in_paid/payments',
      data: [
        {
          id: 'inpay_1',
          object: 'invoice_payment',
          amount_paid: amount_paid ?? 5_145,
          amount_requested: amount_paid ?? 5_145,
          created: ACTIVATION,
          currency: 'usd',
          invoice: id ?? 'in_paid',
          is_default: true,
          livemode: false,
          status: 'paid',
          status_transitions: { canceled_at: null, paid_at: ACTIVATION + 10 },
          payment: {
            type: 'payment_intent',
            payment_intent: {
              id: 'pi_1',
              latest_charge: 'ch_1',
            } as Stripe.PaymentIntent,
          },
        } as Stripe.InvoicePayment,
      ],
    },
    ...invoiceOverrides,
    metadata: metadata ?? {},
    lines: {
      object: 'list',
      data: lines,
      has_more: has_more ?? false,
      url: '/v1/invoices/in_paid/lines',
    },
  } as Stripe.Invoice;
}

async function persistCheckoutAssessment(
  store: ServiceFeeSettlementStore,
  input: {
    assessmentKey: string;
    eligibleSubtotalMinor: number;
    invoiceId?: string | null;
    chargedFeeMinor?: number;
  }
) {
  const decision = await prepareServiceFeeAssessmentDecision({
    assessmentKey: input.assessmentKey,
    flow: 'personal_kilo_pass',
    currency: 'usd',
    eligibilityCreatedAt: new Date(ACTIVATION * 1000),
    eligibleSubtotalMinor: input.eligibleSubtotalMinor,
    kiloUserId: 'user_1',
    stripeCustomerId: 'cus_1',
  });
  const record = await upsertServiceFeeAssessment({
    store,
    decision,
    stripeIds: {
      stripeCustomerId: 'cus_1',
      stripeInvoiceId: input.invoiceId === undefined ? 'in_paid' : input.invoiceId,
      stripeCheckoutSessionId: 'cs_1',
    },
  });
  if (input.chargedFeeMinor !== undefined) {
    return markServiceFeeAssessmentCharged({
      store,
      assessmentKey: record.assessmentKey,
      chargedFeeMinor: input.chargedFeeMinor,
    });
  }
  if (decision.outcome === 'pending') {
    return markServiceFeeAssessmentCharged({
      store,
      assessmentKey: record.assessmentKey,
      chargedFeeMinor: 0,
    });
  }
  return record;
}

describe('settleKiloPassInvoiceServiceFee', () => {
  test('ignores invoices without paid evidence', async () => {
    const store = createMemorySettlementStore();
    await persistCheckoutAssessment(store, {
      assessmentKey: 'checkout:abc',
      eligibleSubtotalMinor: 4_900,
    });

    const result = await settleKiloPassInvoiceServiceFee({
      invoice: {
        ...paidInvoice([pricedLine(KILO_PASS_PRICE_ID, 4_900)]),
        status: 'open',
        status_transitions: {
          finalized_at: ACTIVATION,
          marked_uncollectible_at: null,
          paid_at: null,
          voided_at: null,
        },
      },
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
    });

    expect(result.status).toBe('ignored');
    expect(result.assessment?.settledAt ?? null).toBeNull();
  });

  test('paginates lines and resolves the assessment by metadata then invoice id', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = 'checkout:meta';
    await persistCheckoutAssessment(store, {
      assessmentKey,
      eligibleSubtotalMinor: 4_900,
      invoiceId: null,
    });

    const pages = [
      [pricedLine(KILO_PASS_PRICE_ID, 3_920, { id: 'il_1' })],
      [feeLine(assessmentKey, 196, { id: 'il_fee_page' })],
    ];
    const listLineItems = jest
      .fn<
        (
          invoiceId: string,
          params?: Stripe.InvoiceListLineItemsParams
        ) => Promise<{
          data: Stripe.InvoiceLineItem[];
          has_more: boolean;
        }>
      >()
      .mockResolvedValueOnce({ data: pages[0]!, has_more: true })
      .mockResolvedValueOnce({ data: pages[1]!, has_more: false });

    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice(pages[0]!, {
        has_more: true,
        amount_paid: 4_116,
        metadata: { serviceFeeAssessmentKey: assessmentKey },
      }),
      stripe: {
        invoices: {
          listLineItems: listLineItems as never,
        },
      },
      store,
    });

    expect(listLineItems).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'settled',
      settledProductMinor: 3_920,
      chargedFeeMinor: 196,
      grossPaidMinor: 4_116,
    });
    expect(result.assessment?.assessmentKey).toBe(assessmentKey);

    const byInvoice = await persistCheckoutAssessment(store, {
      assessmentKey: createInvoiceServiceFeeAssessmentKey('in_by_id'),
      eligibleSubtotalMinor: 4_900,
      invoiceId: 'in_by_id',
    });
    const fromStore = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice(
        [
          pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_full' }),
          feeLine(byInvoice.assessmentKey, 245, { id: 'il_fee_full' }),
        ],
        { id: 'in_by_id', amount_paid: 5_145, metadata: {} }
      ),
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
    });
    expect(fromStore.assessment?.assessmentKey).toBe(byInvoice.assessmentKey);
    expect(fromStore.chargedFeeMinor).toBe(245);
  });

  test('discounted checkout settles below expected from the observed fee line', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = 'checkout:discount';
    await persistCheckoutAssessment(store, {
      assessmentKey,
      eligibleSubtotalMinor: 4_900,
    });

    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice(
        [
          pricedLine(KILO_PASS_PRICE_ID, 3_920, {
            id: 'il_pass',
            pretax_credit_amounts: [{ amount: 980, type: 'discount', discount: 'di_1' }],
            amount: 4_900,
          }),
          feeLine(assessmentKey, 196, {
            pretax_credit_amounts: [{ amount: 49, type: 'discount', discount: 'di_1' }],
            amount: 245,
          }),
        ],
        {
          amount_paid: 4_116,
          metadata: { serviceFeeAssessmentKey: assessmentKey },
        }
      ),
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
    });

    expect(result).toMatchObject({
      status: 'settled',
      settledProductMinor: 3_920,
      chargedFeeMinor: 196,
      grossPaidMinor: 4_116,
    });
    expect(result.assessment?.expectedFeeMinor).toBe(245);
    expect(result.assessment?.metadata.service_fee_rate_deviation).toBeUndefined();
  });

  test('100% discount settles product 0 fee 0 as charged', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = 'checkout:free';
    await persistCheckoutAssessment(store, {
      assessmentKey,
      eligibleSubtotalMinor: 4_900,
    });

    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice(
        [
          pricedLine(KILO_PASS_PRICE_ID, 0, {
            id: 'il_pass',
            amount: 4_900,
            pretax_credit_amounts: [{ amount: 4_900, type: 'discount', discount: 'di_100' }],
          }),
          feeLine(assessmentKey, 0, {
            amount: 245,
            pretax_credit_amounts: [{ amount: 245, type: 'discount', discount: 'di_100' }],
          }),
        ],
        {
          amount_paid: 0,
          metadata: { serviceFeeAssessmentKey: assessmentKey },
        }
      ),
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
    });

    expect(result).toMatchObject({
      status: 'settled',
      settledProductMinor: 0,
      chargedFeeMinor: 0,
      grossPaidMinor: 0,
    });
    expect(result.assessment?.outcome).toBe('charged');
  });

  test('restricted coupon deviation is recorded and alerted without correction', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = 'checkout:restricted';
    await persistCheckoutAssessment(store, {
      assessmentKey,
      eligibleSubtotalMinor: 4_900,
    });
    const sendAlert: NonNullable<KiloPassServiceFeeSettlementDependencies['sendAlert']> = jest.fn(
      async () => undefined
    );

    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice(
        [
          pricedLine(KILO_PASS_PRICE_ID, 3_920, {
            id: 'il_pass',
            amount: 4_900,
            pretax_credit_amounts: [{ amount: 980, type: 'discount', discount: 'di_restricted' }],
          }),
          feeLine(assessmentKey, 245),
        ],
        {
          amount_paid: 4_165,
          metadata: { serviceFeeAssessmentKey: assessmentKey },
        }
      ),
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
      deps: { sendAlert },
    });

    expect(calculateServiceFeeMinor(3_920)).toBe(196);
    expect(result).toMatchObject({
      status: 'settled',
      settledProductMinor: 3_920,
      chargedFeeMinor: 245,
      grossPaidMinor: 4_165,
    });
    expect(result.assessment?.metadata.service_fee_rate_deviation).toBe(true);
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: SERVICE_FEE_FAILURE_RATE_DEVIATION })
    );
  });

  test('links invoice, payment intent, and charge ids and is idempotent', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = createInvoiceServiceFeeAssessmentKey('in_ids');
    await persistCheckoutAssessment(store, {
      assessmentKey,
      eligibleSubtotalMinor: 4_900,
      invoiceId: 'in_ids',
    });

    const invoice = paidInvoice(
      [
        pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_pass' }),
        feeLine(assessmentKey, 245, { id: 'il_fee' }),
      ],
      { id: 'in_ids', amount_paid: 5_145 }
    );
    const stripe = {
      invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
    };

    const first = await settleKiloPassInvoiceServiceFee({
      invoice,
      stripe,
      store,
      paymentIntentId: 'pi_1',
      chargeId: 'ch_1',
    });
    const second = await settleKiloPassInvoiceServiceFee({
      invoice,
      stripe,
      store,
      paymentIntentId: 'pi_1',
      chargeId: 'ch_1',
    });

    expect(first).toMatchObject({
      status: 'settled',
      settledProductMinor: 4_900,
      chargedFeeMinor: 245,
      grossPaidMinor: 5_145,
    });
    expect(first.assessment).toMatchObject({
      stripeInvoiceId: 'in_ids',
      stripePaymentIntentId: 'pi_1',
      stripeChargeId: 'ch_1',
      stripeInvoiceFeeLineItemId: 'il_fee',
      settledAt: new Date((ACTIVATION + 10) * 1000).toISOString(),
    });
    expect(second.assessment?.settledAt).toBe(first.assessment?.settledAt);
    expect(second.settledProductMinor).toBe(first.settledProductMinor);
    expect(second.chargedFeeMinor).toBe(first.chargedFeeMinor);
    expect(second.grossPaidMinor).toBe(first.grossPaidMinor);
  });

  test('reconciles a hosted Checkout fee line by persisted price id without metadata', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = 'checkout:price-id';
    const decision = await prepareServiceFeeAssessmentDecision({
      assessmentKey,
      flow: 'personal_kilo_pass',
      currency: 'usd',
      eligibilityCreatedAt: new Date(ACTIVATION * 1000),
      eligibleSubtotalMinor: 4_900,
      kiloUserId: 'user_1',
      stripeCustomerId: 'cus_1',
    });
    await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds: {
        stripeCustomerId: 'cus_1',
        stripeInvoiceId: 'in_price_id',
        stripeCheckoutSessionId: 'cs_price_id',
        stripeFeePriceId: 'price_fee_generated',
      },
    });

    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice(
        [
          pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_pass_price' }),
          invoiceLine({
            id: 'il_fee_no_meta',
            amount: 245,
            metadata: {},
            pricing: {
              type: 'price_details',
              unit_amount_decimal: '245',
              price_details: { price: 'price_fee_generated', product: 'prod_fee' },
            },
          }),
        ],
        {
          id: 'in_price_id',
          amount_paid: 5_145,
          metadata: { serviceFeeAssessmentKey: assessmentKey },
        }
      ),
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
    });

    expect(result).toMatchObject({
      status: 'settled',
      settledProductMinor: 4_900,
      chargedFeeMinor: 245,
      grossPaidMinor: 5_145,
    });
    expect(result.assessment).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 245,
      stripeInvoiceFeeLineItemId: 'il_fee_no_meta',
    });
  });

  test('uses the subscription-aware classifier so unknown-price pass items still settle', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = createInvoiceServiceFeeAssessmentKey('in_sub_aware');
    await persistCheckoutAssessment(store, {
      assessmentKey,
      eligibleSubtotalMinor: 4_900,
      invoiceId: 'in_sub_aware',
    });
    const subscription = {
      id: 'sub_aware',
      items: {
        object: 'list',
        data: [
          {
            id: 'si_pass_aware',
            price: { id: 'price_unknown_pass' },
            metadata: {
              type: 'kilo-pass',
              kiloUserId: 'user_1',
              tier: 'tier_49',
              cadence: 'monthly',
            },
          },
          {
            id: 'si_other',
            price: { id: 'price_unrelated' },
            metadata: {},
          },
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    } as unknown as Stripe.Subscription;
    const retrieve = jest.fn(async (id: string): Promise<Stripe.Subscription> => {
      expect(id).toBe('sub_aware');
      return subscription;
    });

    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice(
        [
          invoiceLine({
            id: 'il_pass_unknown',
            amount: 4_900,
            metadata: {},
            pricing: {
              type: 'price_details',
              unit_amount_decimal: '4900',
              price_details: { price: 'price_unknown_pass', product: 'prod_unknown' },
            },
            parent: {
              type: 'subscription_item_details',
              invoice_item_details: null,
              subscription_item_details: {
                invoice_item: null,
                proration: false,
                proration_details: { credited_items: null },
                subscription: 'sub_aware',
                subscription_item: 'si_pass_aware',
              },
            },
            subscription: 'sub_aware',
          }),
          invoiceLine({
            id: 'il_other',
            amount: 8_000,
            metadata: {},
            pricing: {
              type: 'price_details',
              unit_amount_decimal: '8000',
              price_details: { price: 'price_unrelated', product: 'prod_other' },
            },
            parent: {
              type: 'subscription_item_details',
              invoice_item_details: null,
              subscription_item_details: {
                invoice_item: null,
                proration: false,
                proration_details: { credited_items: null },
                subscription: 'sub_aware',
                subscription_item: 'si_other',
              },
            },
            subscription: 'sub_aware',
          }),
          feeLine(assessmentKey, 245, { id: 'il_fee_aware' }),
        ],
        {
          id: 'in_sub_aware',
          amount_paid: 13_145,
          parent: {
            type: 'subscription_details',
            quote_details: null,
            subscription_details: {
              metadata: { serviceFeeAssessmentKey: assessmentKey },
              subscription: 'sub_aware',
            },
          },
        }
      ),
      stripe: {
        invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
        subscriptions: { retrieve },
      },
      store,
    });

    expect(retrieve).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'settled',
      settledProductMinor: 4_900,
      chargedFeeMinor: 245,
      grossPaidMinor: 13_145,
    });
  });

  test('pending without an observed fee line marks missed and still settles product', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = createInvoiceServiceFeeAssessmentKey('in_pending_missed');
    const decision = await prepareServiceFeeAssessmentDecision({
      assessmentKey,
      flow: 'personal_kilo_pass',
      currency: 'usd',
      eligibilityCreatedAt: new Date(ACTIVATION * 1000),
      eligibleSubtotalMinor: 4_900,
      kiloUserId: 'user_1',
      stripeCustomerId: 'cus_1',
    });
    await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds: {
        stripeCustomerId: 'cus_1',
        stripeInvoiceId: 'in_pending_missed',
      },
    });

    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice([pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_pass_pending' })], {
        id: 'in_pending_missed',
        amount_paid: 4_900,
        metadata: { serviceFeeAssessmentKey: assessmentKey },
      }),
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
    });

    expect(result).toMatchObject({
      status: 'settled',
      settledProductMinor: 4_900,
      chargedFeeMinor: 0,
      grossPaidMinor: 4_900,
    });
    expect(result.assessment).toMatchObject({
      outcome: 'missed',
      failureCode: 'fee_application_failed',
      chargedFeeMinor: 0,
      settledAt: expect.any(String),
    });
  });

  test('pre-activation invoice without an assessment does not alert', async () => {
    const store = createMemorySettlementStore();
    const sendAlert: NonNullable<KiloPassServiceFeeSettlementDependencies['sendAlert']> = jest.fn(
      async () => undefined
    );
    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice([pricedLine(KILO_PASS_PRICE_ID, 4_900)], {
        id: 'in_legacy',
        amount_paid: 4_900,
        created: ACTIVATION - 1,
      }),
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
      deps: { sendAlert },
    });

    expect(result).toMatchObject({
      status: 'ignored',
      settledProductMinor: 4_900,
      assessment: null,
    });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  test('missing assessment ignores fee revenue and returns product-only amount', async () => {
    const store = createMemorySettlementStore();
    const sendAlert: NonNullable<KiloPassServiceFeeSettlementDependencies['sendAlert']> = jest.fn(
      async () => undefined
    );
    const result = await settleKiloPassInvoiceServiceFee({
      invoice: paidInvoice(
        [
          pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_pass_missing' }),
          feeLine('checkout:missing', 245, { id: 'il_fee_missing' }),
        ],
        { id: 'in_missing', amount_paid: 5_145, metadata: {} }
      ),
      stripe: { invoices: { listLineItems: async () => ({ data: [], has_more: false }) } },
      store,
      deps: { sendAlert },
    });

    expect(result).toMatchObject({
      status: 'ignored',
      settledProductMinor: 4_900,
      chargedFeeMinor: 0,
      grossPaidMinor: 5_145,
      assessment: null,
    });
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'missing_assessment' })
    );
  });

  test('applies a full refund observed before paid and is idempotent on replay', async () => {
    const store = createMemorySettlementStore();
    const assessmentKey = createInvoiceServiceFeeAssessmentKey('in_refund_first');
    await persistCheckoutAssessment(store, {
      assessmentKey,
      eligibleSubtotalMinor: 4_900,
      invoiceId: 'in_refund_first',
    });
    await store.update(assessmentKey, { refundedGrossMinor: 5_145 });

    const invoice = paidInvoice(
      [
        pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_pass_refund_first' }),
        feeLine(assessmentKey, 245, { id: 'il_fee_refund_first' }),
      ],
      { id: 'in_refund_first', amount_paid: 5_145 }
    );
    const stripe = {
      invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
    };

    const first = await settleKiloPassInvoiceServiceFee({
      invoice,
      stripe,
      store,
      paymentIntentId: 'pi_refund_first',
      chargeId: 'ch_refund_first',
    });
    const second = await settleKiloPassInvoiceServiceFee({
      invoice,
      stripe,
      store,
      paymentIntentId: 'pi_refund_first',
      chargeId: 'ch_refund_first',
    });

    expect(first.assessment).toMatchObject({
      settledProductMinor: 4_900,
      chargedFeeMinor: 245,
      refundedGrossMinor: 5_145,
      refundedProductMinor: 4_900,
      refundedFeeMinor: 245,
      outcome: 'charged',
    });
    expect(second.assessment).toMatchObject({
      refundedProductMinor: 4_900,
      refundedFeeMinor: 245,
      refundedGrossMinor: 5_145,
      settledAt: first.assessment?.settledAt,
    });
  });
});
