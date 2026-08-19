import { describe, expect, test, jest } from '@jest/globals';
import type Stripe from 'stripe';

import {
  ServiceFeeAssessmentConflictError,
  prepareServiceFeeAssessmentDecision,
  upsertServiceFeeAssessment,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
} from '@/lib/service-fees/assessments';
import {
  SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
  SERVICE_FEE_DESCRIPTION,
  SERVICE_FEE_METADATA_TYPE,
  SERVICE_FEE_RATE_BASIS_POINTS,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';
import {
  attachPreparedAutoTopUpInvoiceFee,
  buildTopUpServiceFeeCheckoutLineItem,
  checkoutFeeDecisionDisagreesWithSessionCreated,
  createCheckoutServiceFeeAssessmentKey,
  createInvoiceServiceFeeAssessmentKey,
  createTopUpCheckoutSession,
  type CheckoutSessionLike,
  isKiloOwnedAutoTopUpInvoice,
  isWithinServiceFeeActivationBoundaryWindow,
  mergeServiceFeeCommercialMetadata,
  prepareAutoTopUpInvoiceFee,
  prepareTopUpCheckoutFee,
  resolveFixedUsdPriceUnitAmount,
  settleTrustedAutoTopUpInvoice,
  settleTrustedTopUpCharge,
  SERVICE_FEE_FAILURE_ACTIVATION_BOUNDARY,
  SERVICE_FEE_FAILURE_APPLICATION,
  type ServiceFeeCheckoutDependencies,
} from '@/lib/service-fees/checkout';
import { buildInheritedInlineServiceFeeTaxInput } from '@/lib/service-fees/tax';

function createMemoryAssessmentStore(): ServiceFeeAssessmentStore {
  const rows = new Map<string, ServiceFeeAssessmentRecord>();
  const store: ServiceFeeAssessmentStore = {
    async transact(fn) {
      return fn(store);
    },
    async findByAssessmentKey(assessmentKey) {
      const row = rows.get(assessmentKey);
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
        metadata: { ...existing.metadata, ...(patch.metadata ?? {}) },
      };
      rows.set(assessmentKey, next);
      return { ...next };
    },
  };
  return store;
}

const ACTIVATION = new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000);
const BEFORE_ACTIVATION = new Date((SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 1) * 1000);
const NEAR_BEFORE = new Date((SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 30) * 1000);
const NEAR_AFTER = new Date((SERVICE_FEE_ACTIVATION_UNIX_SECONDS + 30) * 1000);
const FAR_AFTER = new Date((SERVICE_FEE_ACTIVATION_UNIX_SECONDS + 120) * 1000);

function approvedTax() {
  return buildInheritedInlineServiceFeeTaxInput();
}

function deps(
  store: ServiceFeeAssessmentStore,
  overrides: Partial<ServiceFeeCheckoutDependencies> = {}
): ServiceFeeCheckoutDependencies {
  return {
    store,
    now: ACTIVATION,
    sendAlert: jest.fn(async () => undefined),
    resolveTaxInput: async () => {
      throw new Error(SERVICE_FEE_FAILURE_APPLICATION);
    },
    ...overrides,
  };
}

describe('checkout service-fee helpers', () => {
  test('assessment keys and kilo-owned invoice skip', () => {
    expect(createCheckoutServiceFeeAssessmentKey('11111111-1111-4111-8111-111111111111')).toBe(
      'checkout:11111111-1111-4111-8111-111111111111'
    );
    expect(createInvoiceServiceFeeAssessmentKey('in_123')).toBe('invoice:in_123');
    expect(isKiloOwnedAutoTopUpInvoice({ metadata: { type: 'auto-topup' } })).toBe(true);
    expect(isKiloOwnedAutoTopUpInvoice({ metadata: { type: 'org-auto-topup' } })).toBe(true);
    expect(isKiloOwnedAutoTopUpInvoice({ metadata: { type: 'kilo-pass' } })).toBe(false);
  });

  test('activation boundary window and decision disagreement', () => {
    expect(
      isWithinServiceFeeActivationBoundaryWindow(SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 60)
    ).toBe(true);
    expect(
      isWithinServiceFeeActivationBoundaryWindow(SERVICE_FEE_ACTIVATION_UNIX_SECONDS + 61)
    ).toBe(false);
    expect(
      checkoutFeeDecisionDisagreesWithSessionCreated({
        preparedOutcome: 'pending',
        sessionCreatedUnixSeconds: SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 1,
      })
    ).toBe(true);
    expect(
      checkoutFeeDecisionDisagreesWithSessionCreated({
        preparedOutcome: 'pre_activation',
        sessionCreatedUnixSeconds: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      })
    ).toBe(true);
    expect(
      checkoutFeeDecisionDisagreesWithSessionCreated({
        preparedOutcome: 'pending',
        sessionCreatedUnixSeconds: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      })
    ).toBe(false);
  });

  test('fixed usd price requires unit_amount', async () => {
    await expect(
      resolveFixedUsdPriceUnitAmount({
        stripe: {
          prices: {
            retrieve: async () => ({
              id: 'price_1',
              currency: 'usd',
              unit_amount: 10_000,
              tax_behavior: 'unspecified',
            }),
          },
        },
        priceId: 'price_1',
      })
    ).resolves.toBe(10_000);

    await expect(
      resolveFixedUsdPriceUnitAmount({
        stripe: {
          prices: {
            retrieve: async () => ({
              id: 'price_2',
              currency: 'eur',
              unit_amount: 10_000,
              tax_behavior: 'unspecified',
            }),
          },
        },
        priceId: 'price_2',
      })
    ).rejects.toThrow(/must be usd/);

    await expect(
      resolveFixedUsdPriceUnitAmount({
        stripe: {
          prices: {
            retrieve: async () => ({
              id: 'price_3',
              currency: 'usd',
              unit_amount: null,
              tax_behavior: 'unspecified',
            }),
          },
        },
        priceId: 'price_3',
      })
    ).rejects.toThrow(/fixed usd unit_amount/);
  });

  test('positive fee line carries exact product_data metadata', () => {
    const line = buildTopUpServiceFeeCheckoutLineItem({
      assessmentKey: 'checkout:abc',
      feeMinor: 500,
      taxInput: approvedTax(),
    });
    expect(line.price_data?.product_data?.name).toBe(SERVICE_FEE_DESCRIPTION);
    expect(line.price_data?.unit_amount).toBe(500);
    expect(line.price_data?.product_data?.metadata).toEqual({
      type: SERVICE_FEE_METADATA_TYPE,
      serviceFeeVersion: SERVICE_FEE_VERSION,
      serviceFeeAssessmentKey: 'checkout:abc',
      serviceFeeRateBasisPoints: String(SERVICE_FEE_RATE_BASIS_POINTS),
    });
    expect(line.price_data?.recurring).toBeUndefined();
  });
});

describe('prepareTopUpCheckoutFee', () => {
  test('tax resolution failure fails open with missed and no line', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store),
    });

    expect(prepared.checkoutLineItem).toBeUndefined();
    expect(prepared.outcome).toBe('missed');
    expect(prepared.failureCode).toBe(SERVICE_FEE_FAILURE_APPLICATION);
    expect(prepared.expectedFeeMinor).toBe(500);
    expect(prepared.commercialMetadata).toMatchObject({
      serviceFeeAssessmentKey: prepared.assessmentKey,
      serviceFeePrincipalMinor: '10000',
      serviceFeeFlow: 'personal_top_up',
    });
  });

  test('repeated decision failure falls back to a terminal missed assessment', async () => {
    const store = createMemoryAssessmentStore();
    const findEffectiveExemption = jest.fn(async () => {
      throw new Error('exemption lookup unavailable');
    });
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'organization_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      organizationId: 'org_1',
      deps: deps(store, { findEffectiveExemption }),
    });

    expect(prepared).toMatchObject({
      outcome: 'missed',
      expectedFeeMinor: 500,
      failureCode: SERVICE_FEE_FAILURE_APPLICATION,
    });

    await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: feeLine => ({
        mode: 'payment',
        line_items: feeLine ? [{ quantity: 1 }, feeLine] : [{ quantity: 1 }],
      }),
      createSession: async () => ({
        id: 'cs_double_failure',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      }),
      deps: deps(store),
    });

    expect(await store.findByAssessmentKey(prepared.assessmentKey)).toMatchObject({
      outcome: 'missed',
      expectedFeeMinor: 500,
      failureCode: SERVICE_FEE_FAILURE_APPLICATION,
    });
    expect(findEffectiveExemption).toHaveBeenCalledTimes(2);
  });

  test('injected approved tax builds a positive fee line', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, {
        resolveTaxInput: async () => approvedTax(),
      }),
    });

    expect(prepared.outcome).toBe('pending');
    expect(prepared.checkoutLineItem?.price_data?.unit_amount).toBe(500);
    expect(prepared.checkoutLineItem?.price_data?.product_data?.name).toBe(SERVICE_FEE_DESCRIPTION);
  });

  test('exact organization exemption omits the fee line', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'organization_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      organizationId: 'org_1',
      deps: deps(store, {
        resolveTaxInput: async () => approvedTax(),
        findEffectiveExemption: async () => ({ id: 'hist_1', isExempt: true }),
      }),
    });

    expect(prepared.outcome).toBe('exempt');
    expect(prepared.checkoutLineItem).toBeUndefined();
    expect(prepared.decision.exemptionId).toBe('hist_1');
    expect(prepared.expectedFeeMinor).toBe(500);
  });

  test('pre-activation omits the fee line', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_auto_top_up_setup',
      principalMinor: 5_000,
      kiloUserId: 'user_1',
      deps: deps(store, {
        now: BEFORE_ACTIVATION,
        resolveTaxInput: async () => approvedTax(),
      }),
    });
    expect(prepared.outcome).toBe('pre_activation');
    expect(prepared.checkoutLineItem).toBeUndefined();
    expect(prepared.expectedFeeMinor).toBe(250);
  });
});

describe('createTopUpCheckoutSession', () => {
  test('creates principal-only checkout after fee preparation failure and persists session', async () => {
    const store = createMemoryAssessmentStore();
    const createSession = jest.fn(
      async (_params: Stripe.Checkout.SessionCreateParams): Promise<CheckoutSessionLike> => ({
        id: 'cs_missed',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/missed',
        line_items: { data: [], has_more: false },
      })
    );
    const sendAlert = jest.fn(async () => undefined);
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, { sendAlert }),
    });

    const session = await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: feeLine => ({
        mode: 'payment',
        line_items: feeLine ? [{ quantity: 1 }, feeLine] : [{ quantity: 1 }],
      }),
      createSession,
      deps: deps(store, { sendAlert }),
    });

    expect(session.id).toBe('cs_missed');
    expect(createSession).toHaveBeenCalledTimes(1);
    const createParams = createSession.mock.calls[0]?.[0];
    expect(createParams?.line_items).toHaveLength(1);
    const record = await store.findByAssessmentKey(prepared.assessmentKey);
    expect(record).toMatchObject({
      outcome: 'missed',
      failureCode: SERVICE_FEE_FAILURE_APPLICATION,
      stripeCheckoutSessionId: 'cs_missed',
      chargedFeeMinor: 0,
      eligibilityCreatedAt: new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000).toISOString(),
    });
    expect(sendAlert).toHaveBeenCalled();
  });

  test('persists positive fee line identity after session create', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'organization_auto_top_up_setup',
      principalMinor: 50_000,
      kiloUserId: 'user_1',
      organizationId: 'org_1',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });

    const feeLine = {
      id: 'li_fee',
      price: {
        id: 'price_fee',
        product: {
          id: 'prod_fee',
          metadata: {
            type: SERVICE_FEE_METADATA_TYPE,
            serviceFeeVersion: SERVICE_FEE_VERSION,
          },
        },
      },
    } as unknown as Stripe.LineItem;

    const session = await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: line => ({
        mode: 'payment',
        line_items: [{ quantity: 1 }, ...(line ? [line] : [])],
      }),
      createSession: async () => ({
        id: 'cs_fee',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/fee',
        line_items: { data: [feeLine], has_more: false },
      }),
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });

    expect(session.id).toBe('cs_fee');
    const record = await store.findByAssessmentKey(prepared.assessmentKey);
    expect(record).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 0,
      stripeCheckoutSessionId: 'cs_fee',
      stripeCheckoutFeeLineItemId: 'li_fee',
      stripeFeePriceId: 'price_fee',
    });
  });

  test('near-boundary disagreement expires and replaces once', async () => {
    const store = createMemoryAssessmentStore();
    const expire = jest.fn(async (_sessionId: string) => undefined);
    const createSession = jest
      .fn<(params: Stripe.Checkout.SessionCreateParams) => Promise<CheckoutSessionLike>>()
      .mockResolvedValueOnce({
        id: 'cs_early',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/early',
      })
      .mockResolvedValueOnce({
        id: 'cs_replaced',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/replaced',
        line_items: { data: [], has_more: false },
      });

    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, {
        now: NEAR_BEFORE,
        resolveTaxInput: async () => approvedTax(),
      }),
    });
    expect(prepared.outcome).toBe('pre_activation');

    const session = await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: line => ({
        mode: 'payment',
        line_items: line ? [{ quantity: 1 }, line] : [{ quantity: 1 }],
      }),
      createSession,
      deps: deps(store, {
        now: NEAR_BEFORE,
        resolveTaxInput: async () => approvedTax(),
        expireCheckoutSession: expire,
        listCheckoutLineItems: async () => ({
          data: [
            {
              id: 'li_fee_replaced',
              price: {
                id: 'price_fee_replaced',
                product: {
                  metadata: {
                    type: SERVICE_FEE_METADATA_TYPE,
                    serviceFeeVersion: SERVICE_FEE_VERSION,
                  },
                },
              },
            } as unknown as Stripe.LineItem,
          ],
          has_more: false,
        }),
      }),
    });

    expect(expire).toHaveBeenCalledWith('cs_early');
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(session.id).toBe('cs_replaced');
    const secondParams = createSession.mock.calls[1]?.[0];
    expect(secondParams?.line_items).toHaveLength(2);
  });

  test('outside the one-minute window does not expire or replace', async () => {
    const store = createMemoryAssessmentStore();
    const expire = jest.fn(async () => undefined);
    const createSession = jest.fn(async () => ({
      id: 'cs_far',
      created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS + 90,
      url: 'https://checkout.stripe.com/far',
      line_items: { data: [], has_more: false },
    }));

    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, {
        now: FAR_AFTER,
        resolveTaxInput: async () => approvedTax(),
      }),
    });

    const session = await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: line => ({
        mode: 'payment',
        line_items: line ? [{ quantity: 1 }, line] : [{ quantity: 1 }],
      }),
      createSession,
      deps: deps(store, {
        now: FAR_AFTER,
        expireCheckoutSession: expire,
        resolveTaxInput: async () => approvedTax(),
      }),
    });

    expect(session.id).toBe('cs_far');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(expire).not.toHaveBeenCalled();
  });

  test('replacement that still disagrees fails open to a principal-only session', async () => {
    const store = createMemoryAssessmentStore();
    const createSession = jest
      .fn<(params: Stripe.Checkout.SessionCreateParams) => Promise<CheckoutSessionLike>>()
      .mockResolvedValueOnce({
        id: 'cs_1',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 1,
        url: 'https://checkout.stripe.com/1',
      })
      .mockResolvedValueOnce({
        id: 'cs_2',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/2',
      })
      .mockResolvedValueOnce({
        id: 'cs_3',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/3',
        line_items: { data: [], has_more: false },
      });

    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, {
        now: NEAR_AFTER,
        resolveTaxInput: async () => approvedTax(),
      }),
    });

    const session = await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: line => ({
        mode: 'payment',
        line_items: line ? [{ quantity: 1 }, line] : [{ quantity: 1 }],
      }),
      createSession,
      deps: deps(store, {
        now: NEAR_AFTER,
        resolveTaxInput: async () => approvedTax(),
        expireCheckoutSession: async () => undefined,
      }),
    });

    expect(session.id).toBe('cs_3');
    expect(createSession).toHaveBeenCalledTimes(3);
    const lastParams = createSession.mock.calls[2]?.[0];
    expect(lastParams?.line_items).toHaveLength(1);
    const record = await store.findByAssessmentKey(prepared.assessmentKey);
    expect(record?.outcome).toBe('missed');
    expect(record?.failureCode).toBe(SERVICE_FEE_FAILURE_ACTIVATION_BOUNDARY);
  });

  test('fee-domain errors do not wrap the base Stripe create', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });

    await expect(
      createTopUpCheckoutSession({
        prepared,
        buildSessionParams: () => ({ mode: 'payment', line_items: [] }),
        createSession: async () => {
          throw new Error('stripe_create_failed');
        },
        deps: deps(store),
      })
    ).rejects.toThrow('stripe_create_failed');
  });
});

describe('auto-top-up invoice fee attachment', () => {
  test('tax resolution failure persists missed and does not create a fee item', async () => {
    const store = createMemoryAssessmentStore();
    const sendAlert = jest.fn(async () => undefined);
    const prepared = await prepareAutoTopUpInvoiceFee({
      flow: 'personal_auto_top_up',
      invoiceId: 'in_1',
      principalMinor: 5_000,
      kiloUserId: 'user_1',
      stripeCustomerId: 'cus_1',
      deps: deps(store, { sendAlert }),
    });

    expect(prepared.feeInvoiceItem).toBeUndefined();
    expect(prepared.outcome).toBe('missed');
    const record = await store.findByAssessmentKey(prepared.assessmentKey);
    expect(record).toMatchObject({
      outcome: 'missed',
      failureCode: SERVICE_FEE_FAILURE_APPLICATION,
      stripeInvoiceId: 'in_1',
    });
    expect(sendAlert).toHaveBeenCalled();
  });

  test('approved tax attaches one non-discountable fee item before pay', async () => {
    const store = createMemoryAssessmentStore();
    const createInvoiceItem = jest.fn(async () => ({ id: 'ii_fee' }));
    const prepared = await prepareAutoTopUpInvoiceFee({
      flow: 'organization_auto_top_up',
      invoiceId: 'in_org',
      principalMinor: 50_000,
      organizationId: 'org_1',
      kiloUserId: 'user_1',
      stripeCustomerId: 'cus_org',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });

    expect(prepared.feeInvoiceItem).toMatchObject({
      invoice: 'in_org',
      amount: 2_500,
      discountable: false,
      description: SERVICE_FEE_DESCRIPTION,
      metadata: {
        type: SERVICE_FEE_METADATA_TYPE,
        serviceFeeAssessmentKey: prepared.assessmentKey,
      },
    });

    const charged = await attachPreparedAutoTopUpInvoiceFee({
      prepared,
      deps: deps(store, { createInvoiceItem }),
    });
    expect(createInvoiceItem).toHaveBeenCalledTimes(1);
    expect(charged).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 2_500,
      stripeInvoiceFeeLineItemId: 'ii_fee',
    });
  });
});

describe('trusted principal settlement', () => {
  test('credits principal from trusted metadata and settles before returning email amounts', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });
    await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: line => ({
        mode: 'payment',
        line_items: line ? [{ quantity: 1 }, line] : [{ quantity: 1 }],
      }),
      createSession: async () => ({
        id: 'cs_settle',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/settle',
        line_items: {
          data: [
            {
              id: 'li_fee_settle',
              price: {
                id: 'price_fee_settle',
                product: {
                  metadata: {
                    type: SERVICE_FEE_METADATA_TYPE,
                    serviceFeeVersion: SERVICE_FEE_VERSION,
                  },
                },
              },
            } as unknown as Stripe.LineItem,
          ],
          has_more: false,
        },
      }),
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });

    const result = await settleTrustedTopUpCharge({
      charge: {
        id: 'ch_1',
        amount: 10_500,
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        customer: 'cus_1',
      },
      paymentIntent: {
        id: 'pi_1',
        metadata: {
          serviceFeeAssessmentKey: prepared.assessmentKey,
          serviceFeePrincipalMinor: '10000',
          type: 'stripe-checkout-topup',
        },
        customer: 'cus_1',
      },
      kiloUserId: 'user_1',
      deps: deps(store),
    });

    expect(result).toMatchObject({
      shouldCredit: true,
      principalMinor: 10_000,
      chargedFeeMinor: 500,
      grossPaidMinor: 10_500,
    });
    const record = await store.findByAssessmentKey(prepared.assessmentKey);
    expect(record?.settledAt).toBeTruthy();
    expect(record?.settledProductMinor).toBe(10_000);
    expect(record?.stripeChargeId).toBe('ch_1');
  });

  test('duplicate settlement is idempotent', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });
    await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: () => ({ mode: 'payment', line_items: [] }),
      createSession: async () => ({
        id: 'cs_dup',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/dup',
        line_items: {
          data: [
            {
              id: 'li_dup',
              price: {
                id: 'price_dup',
                product: {
                  metadata: {
                    type: SERVICE_FEE_METADATA_TYPE,
                    serviceFeeVersion: SERVICE_FEE_VERSION,
                  },
                },
              },
            } as unknown as Stripe.LineItem,
          ],
          has_more: false,
        },
      }),
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });

    const charge = {
      id: 'ch_dup',
      amount: 10_500,
      created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      customer: 'cus_1',
    };
    const paymentIntent = {
      id: 'pi_dup',
      metadata: {
        serviceFeeAssessmentKey: prepared.assessmentKey,
        serviceFeePrincipalMinor: '10000',
      },
      customer: 'cus_1',
    };
    const first = await settleTrustedTopUpCharge({
      charge,
      paymentIntent,
      kiloUserId: 'user_1',
      deps: deps(store),
    });
    const second = await settleTrustedTopUpCharge({
      charge,
      paymentIntent,
      kiloUserId: 'user_1',
      deps: deps(store),
    });
    expect(second.principalMinor).toBe(first.principalMinor);
    expect(second.assessment?.settledAt).toBe(first.assessment?.settledAt);
  });

  test('legacy pre-activation without fee metadata uses charge.amount', async () => {
    const store = createMemoryAssessmentStore();
    const result = await settleTrustedTopUpCharge({
      charge: {
        id: 'ch_legacy',
        amount: 2300,
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS + 10,
        customer: 'cus_1',
      },
      paymentIntent: {
        id: 'pi_legacy',
        metadata: { type: 'stripe-checkout-topup' },
        customer: 'cus_1',
      },
      kiloUserId: 'user_1',
      deps: deps(store, {
        retrieveCheckoutSessionCreated: async () => SERVICE_FEE_ACTIVATION_UNIX_SECONDS - 5,
      }),
    });
    expect(result).toMatchObject({
      shouldCredit: true,
      principalMinor: 2300,
      chargedFeeMinor: 0,
    });
  });

  test('post-activation metadata-free events do not grant gross charge.amount', async () => {
    const store = createMemoryAssessmentStore();
    const sendAlert: NonNullable<ServiceFeeCheckoutDependencies['sendAlert']> = jest.fn(
      async () => undefined
    );
    const result = await settleTrustedTopUpCharge({
      charge: {
        id: 'ch_bad',
        amount: 10_500,
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        customer: 'cus_1',
      },
      paymentIntent: {
        id: 'pi_bad',
        metadata: { type: 'stripe-checkout-topup' },
        customer: 'cus_1',
      },
      kiloUserId: 'user_1',
      deps: deps(store, {
        sendAlert,
        retrieveCheckoutSessionCreated: async () => SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      }),
    });
    expect(result.shouldCredit).toBe(false);
    expect(result.principalMinor).toBe(0);
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'principal_untrusted' })
    );
  });

  test('auto invoice settlement uses principal metadata not amount_paid', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareAutoTopUpInvoiceFee({
      flow: 'personal_auto_top_up',
      invoiceId: 'in_paid',
      principalMinor: 5_000,
      kiloUserId: 'user_1',
      stripeCustomerId: 'cus_1',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });
    await attachPreparedAutoTopUpInvoiceFee({
      prepared,
      deps: deps(store, { createInvoiceItem: async () => ({ id: 'ii_paid' }) }),
    });

    const result = await settleTrustedAutoTopUpInvoice({
      invoice: {
        id: 'in_paid',
        amount_paid: 5_250,
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        metadata: {
          type: 'auto-topup',
          serviceFeeAssessmentKey: prepared.assessmentKey,
          serviceFeePrincipalMinor: '5000',
        },
        status_transitions: {
          finalized_at: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
          marked_uncollectible_at: null,
          paid_at: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
          voided_at: null,
        },
        customer: 'cus_1',
      },
      chargeId: 'ch_paid',
      kiloUserId: 'user_1',
      flow: 'personal_auto_top_up',
      deps: deps(store),
    });

    expect(result).toMatchObject({
      shouldCredit: true,
      principalMinor: 5_000,
      chargedFeeMinor: 250,
      grossPaidMinor: 5_250,
    });
  });

  test('pending settlement without a trusted fee line marks missed and still credits principal', async () => {
    const store = createMemoryAssessmentStore();
    const sendAlert: NonNullable<ServiceFeeCheckoutDependencies['sendAlert']> = jest.fn(
      async () => undefined
    );
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });
    await upsertServiceFeeAssessment({
      store,
      decision: prepared.decision,
      stripeIds: { stripeCustomerId: 'cus_1' },
    });

    const result = await settleTrustedTopUpCharge({
      charge: {
        id: 'ch_pending_missed',
        amount: 10_500,
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        customer: 'cus_1',
      },
      paymentIntent: {
        id: 'pi_pending_missed',
        metadata: {
          serviceFeeAssessmentKey: prepared.assessmentKey,
          serviceFeePrincipalMinor: '10000',
        },
        customer: 'cus_1',
      },
      kiloUserId: 'user_1',
      deps: deps(store, { sendAlert }),
    });

    expect(result).toMatchObject({
      shouldCredit: true,
      principalMinor: 10_000,
      chargedFeeMinor: 0,
      grossPaidMinor: 10_500,
    });
    expect(result.assessment).toMatchObject({
      outcome: 'missed',
      chargedFeeMinor: 0,
      failureCode: 'fee_application_failed',
      settledAt: expect.any(String),
      settledProductMinor: 10_000,
    });
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'fee_application_failed' })
    );
  });

  test('pending settlement with a trusted fee line identity books the observed fee', async () => {
    const store = createMemoryAssessmentStore();
    const decision = await prepareServiceFeeAssessmentDecision({
      assessmentKey: 'checkout:trusted-pending',
      flow: 'personal_top_up',
      currency: 'usd',
      eligibilityCreatedAt: ACTIVATION,
      eligibleSubtotalMinor: 10_000,
      kiloUserId: 'user_1',
      stripeCustomerId: 'cus_1',
    });
    await upsertServiceFeeAssessment({
      store,
      decision,
      stripeIds: {
        stripeCustomerId: 'cus_1',
        stripeCheckoutFeeLineItemId: 'li_fee_trusted',
        stripeFeePriceId: 'price_fee_trusted',
      },
    });

    const result = await settleTrustedTopUpCharge({
      charge: {
        id: 'ch_pending_trusted',
        amount: 10_500,
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        customer: 'cus_1',
      },
      paymentIntent: {
        id: 'pi_pending_trusted',
        metadata: {
          serviceFeeAssessmentKey: 'checkout:trusted-pending',
          serviceFeePrincipalMinor: '10000',
        },
        customer: 'cus_1',
      },
      kiloUserId: 'user_1',
      deps: deps(store),
    });

    expect(result).toMatchObject({
      shouldCredit: true,
      principalMinor: 10_000,
      chargedFeeMinor: 500,
      grossPaidMinor: 10_500,
    });
    expect(result.assessment).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 500,
      settledProductMinor: 10_000,
    });
  });

  test('pending auto-top-up settlement does not book the expected fee', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareAutoTopUpInvoiceFee({
      flow: 'personal_auto_top_up',
      invoiceId: 'in_pending',
      principalMinor: 5_000,
      kiloUserId: 'user_1',
      stripeCustomerId: 'cus_1',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });
    expect(prepared.outcome).toBe('pending');

    const result = await settleTrustedAutoTopUpInvoice({
      invoice: {
        id: 'in_pending',
        amount_paid: 5_250,
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        metadata: {
          type: 'auto-topup',
          serviceFeeAssessmentKey: prepared.assessmentKey,
          serviceFeePrincipalMinor: '5000',
        },
        status_transitions: {
          finalized_at: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
          marked_uncollectible_at: null,
          paid_at: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
          voided_at: null,
        },
        customer: 'cus_1',
      },
      chargeId: 'ch_pending_auto',
      kiloUserId: 'user_1',
      flow: 'personal_auto_top_up',
      deps: deps(store),
    });

    expect(result).toMatchObject({
      shouldCredit: true,
      principalMinor: 5_000,
      chargedFeeMinor: 0,
      grossPaidMinor: 5_250,
    });
    expect(result.assessment).toMatchObject({
      outcome: 'missed',
      failureCode: 'fee_application_failed',
      chargedFeeMinor: 0,
    });
  });

  test('conflicting principal throws rather than granting the wrong credits', async () => {
    const store = createMemoryAssessmentStore();
    const prepared = await prepareTopUpCheckoutFee({
      flow: 'personal_top_up',
      principalMinor: 10_000,
      kiloUserId: 'user_1',
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });
    await createTopUpCheckoutSession({
      prepared,
      buildSessionParams: () => ({ mode: 'payment', line_items: [] }),
      createSession: async () => ({
        id: 'cs_conflict',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        url: 'https://checkout.stripe.com/conflict',
        line_items: {
          data: [
            {
              id: 'li_conflict',
              price: {
                id: 'price_conflict',
                product: {
                  metadata: {
                    type: SERVICE_FEE_METADATA_TYPE,
                    serviceFeeVersion: SERVICE_FEE_VERSION,
                  },
                },
              },
            } as unknown as Stripe.LineItem,
          ],
          has_more: false,
        },
      }),
      deps: deps(store, { resolveTaxInput: async () => approvedTax() }),
    });

    await expect(
      settleTrustedTopUpCharge({
        charge: {
          id: 'ch_c',
          amount: 10_500,
          created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
          customer: 'cus_1',
        },
        paymentIntent: {
          id: 'pi_c',
          metadata: {
            serviceFeeAssessmentKey: prepared.assessmentKey,
            serviceFeePrincipalMinor: '9999',
          },
          customer: 'cus_1',
        },
        kiloUserId: 'user_1',
        deps: deps(store),
      })
    ).rejects.toThrow(/principal mismatch/);
    expect(ServiceFeeAssessmentConflictError).toBeDefined();
  });
});

describe('mergeServiceFeeCommercialMetadata', () => {
  test('preserves existing metadata', () => {
    expect(
      mergeServiceFeeCommercialMetadata(
        { type: 'stripe-checkout-topup', kiloUserId: 'user_1' },
        {
          serviceFeeAssessmentKey: 'checkout:1',
          serviceFeeVersion: SERVICE_FEE_VERSION,
          serviceFeeFlow: 'personal_top_up',
          serviceFeePrincipalMinor: '10000',
        }
      )
    ).toEqual({
      type: 'stripe-checkout-topup',
      kiloUserId: 'user_1',
      serviceFeeAssessmentKey: 'checkout:1',
      serviceFeeVersion: SERVICE_FEE_VERSION,
      serviceFeeFlow: 'personal_top_up',
      serviceFeePrincipalMinor: '10000',
    });
  });
});
