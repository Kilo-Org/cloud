import { describe, expect, test, jest } from '@jest/globals';
import type Stripe from 'stripe';

import { getKnownStripePriceIdsForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import { getKnownStripePriceIdsForKiloClaw } from '@/lib/kiloclaw/stripe-price-ids.server';
import { SEAT_PRODUCT_IDS } from '@/lib/organizations/stripe-seat-line-items';
import {
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
  handleKiloPassInvoiceCreated,
  SERVICE_FEE_FAILURE_APPLICATION,
  type KiloPassInvoiceCreatedDependencies,
  type KiloPassInvoiceCreatedStripe,
} from '@/lib/service-fees/invoice-created';
import { createInvoiceServiceFeeAssessmentKey } from '@/lib/service-fees/checkout';

const KILO_PASS_PRICE_ID = getKnownStripePriceIdsForKiloPass()[0]!;
const KILOCLAW_PRICE_ID = getKnownStripePriceIdsForKiloClaw()[0]!;
const SEAT_PRODUCT_ID = [...SEAT_PRODUCT_IDS][0]!;
const SEAT_PRICE_ID = process.env.STRIPE_TEAMS_MONTHLY_PRICE_ID!;
const ACTIVATION = SERVICE_FEE_ACTIVATION_UNIX_SECONDS;

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

function invoiceLine(
  overrides: Partial<Stripe.InvoiceLineItem> & {
    amount?: number;
    pricing?: Stripe.InvoiceLineItem['pricing'];
    metadata?: Stripe.Metadata;
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
    invoice: 'in_test',
    livemode: false,
    metadata: overrides.metadata ?? {},
    parent: null,
    period: { start: 1, end: 2 },
    pretax_credit_amounts: null,
    pricing: overrides.pricing ?? null,
    quantity: 1,
    subscription: null,
    taxes: null,
    ...overrides,
  } as Stripe.InvoiceLineItem;
}

function pricedLine(priceId: string, amount: number, extra: Partial<Stripe.InvoiceLineItem> = {}) {
  return invoiceLine({
    amount,
    pricing: {
      type: 'price_details',
      unit_amount_decimal: String(amount),
      price_details: {
        price: priceId,
        product: extra.pricing?.price_details?.product ?? 'prod_pass',
      },
    },
    ...extra,
  });
}

function personalMetadata(): Stripe.Metadata {
  return {
    type: 'kilo-pass',
    kiloUserId: 'user_1',
    tier: 'tier_49',
    cadence: 'monthly',
  };
}

function draftInvoice(
  overrides: {
    id?: string;
    created?: number;
    status?: Stripe.Invoice.Status;
    metadata?: Stripe.Metadata;
    lines?: Stripe.InvoiceLineItem[];
    has_more?: boolean;
    customer?: string;
    parent?: Stripe.Invoice['parent'];
  } = {}
): Stripe.Invoice {
  const { lines: lineItems, has_more, metadata, ...invoiceOverrides } = overrides;
  const lines = lineItems ?? [pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_pass' })];
  const resolvedMetadata = metadata ?? personalMetadata();
  return {
    id: overrides.id ?? 'in_test',
    object: 'invoice',
    created: overrides.created ?? ACTIVATION,
    status: overrides.status ?? 'draft',
    currency: 'usd',
    customer: 'cus_1',
    amount_paid: 0,
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: {
        metadata: resolvedMetadata,
        subscription: 'sub_1',
      },
    },
    ...invoiceOverrides,
    metadata: resolvedMetadata,
    lines: {
      object: 'list',
      data: lines,
      has_more: has_more ?? false,
      url: '/v1/invoices/in_test/lines',
    },
  } as Stripe.Invoice;
}

function stripeClient(
  overrides: Partial<KiloPassInvoiceCreatedStripe> & {
    createInvoiceItem?: KiloPassInvoiceCreatedStripe['invoiceItems'];
    listLineItems?: KiloPassInvoiceCreatedStripe['invoices']['listLineItems'];
  } = {}
): KiloPassInvoiceCreatedStripe {
  return {
    prices: {
      retrieve: async id => ({ id, tax_behavior: 'exclusive' }),
    },
    invoices: {
      listLineItems:
        overrides.listLineItems ??
        (async () => ({
          data: [],
          has_more: false,
        })),
    },
    invoiceItems: overrides.createInvoiceItem ?? {
      create: async () => ({ id: 'ii_fee', amount: 245 }),
    },
    ...overrides,
  };
}

function deps(
  overrides: Partial<KiloPassInvoiceCreatedDependencies> = {}
): KiloPassInvoiceCreatedDependencies {
  return {
    now: new Date(ACTIVATION * 1000),
    sendAlert: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('handleKiloPassInvoiceCreated', () => {
  test('activation minus one second is pre_activation and does not attach a fee', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({ created: ACTIVATION - 1 }),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      }),
    });

    expect(result.status).toBe('assessed');
    expect(result.assessment).toMatchObject({
      outcome: 'pre_activation',
      expectedFeeMinor: 245,
      chargedFeeMinor: 0,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test('activation exact second attaches the fee when tax is available', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({ created: ACTIVATION }),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      }),
    });

    expect(result.status).toBe('charged');
    expect(result.assessment).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 245,
      stripeInvoiceFeeLineItemId: 'ii_fee',
      eligibilityCreatedAt: new Date(ACTIVATION * 1000).toISOString(),
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('discards embedded lines and paginates when has_more is true', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const listLineItems = jest
      .fn<KiloPassInvoiceCreatedStripe['invoices']['listLineItems']>()
      .mockResolvedValueOnce({
        data: [pricedLine(SEAT_PRICE_ID, 72_000, { id: 'il_seat_page' })],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_pass_page' })],
        has_more: false,
      });

    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({
        has_more: true,
        lines: [pricedLine(SEAT_PRICE_ID, 1, { id: 'il_stale_embedded' })],
      }),
      stripe: stripeClient({ listLineItems, createInvoiceItem: { create } }),
      store,
      deps: deps({
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      }),
    });

    expect(listLineItems).toHaveBeenCalled();
    expect(result.assessment?.eligibleSubtotalMinor).toBe(4_900);
    expect(result.assessment?.chargedFeeMinor).toBe(245);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('mixed seat and Kilo Pass invoices charge only the net Kilo Pass subtotal', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async (params: Stripe.InvoiceItemCreateParams) => {
      expect(params.amount).toBe(245);
      return { id: 'ii_fee', amount: 245 };
    });

    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({
        metadata: {
          type: 'kilo-pass-org',
          organizationId: 'org_1',
          kiloUserId: 'user_1',
          tier: 'tier_49',
          cadence: 'monthly',
        },
        lines: [
          pricedLine(SEAT_PRICE_ID, 72_000, {
            id: 'il_seat',
            pricing: {
              type: 'price_details',
              unit_amount_decimal: '72000',
              price_details: { price: SEAT_PRICE_ID, product: SEAT_PRODUCT_ID },
            },
          }),
          pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_pass' }),
        ],
      }),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
        getOrganizationPurchaseChannel: async () => 'self_serve',
      }),
    });

    expect(result.assessment).toMatchObject({
      flow: 'organization_kilo_pass',
      eligibleSubtotalMinor: 4_900,
      chargedFeeMinor: 245,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('skips auto-top-up and excluded invoices but records eligible non-draft leakage', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const client = stripeClient({ createInvoiceItem: { create } });

    const auto = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({ metadata: { type: 'auto-topup' } }),
      stripe: client,
      store,
      deps: deps(),
    });
    const orgAuto = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({
        id: 'in_org_auto',
        metadata: { type: 'org-auto-topup' },
      }),
      stripe: client,
      store,
      deps: deps(),
    });
    const notDraft = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({ id: 'in_open', status: 'open' }),
      stripe: client,
      store,
      deps: deps({
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      }),
    });
    const seats = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({
        id: 'in_seats',
        metadata: {},
        lines: [
          pricedLine(SEAT_PRICE_ID, 72_000, {
            id: 'il_seat_only',
            pricing: {
              type: 'price_details',
              unit_amount_decimal: '72000',
              price_details: { price: SEAT_PRICE_ID, product: SEAT_PRODUCT_ID },
            },
          }),
        ],
      }),
      stripe: client,
      store,
      deps: deps(),
    });
    const claw = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({
        id: 'in_claw',
        metadata: {},
        lines: [pricedLine(KILOCLAW_PRICE_ID, 20_000, { id: 'il_claw' })],
      }),
      stripe: client,
      store,
      deps: deps(),
    });
    const storeManaged = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({ id: 'in_store' }),
      stripe: client,
      store,
      deps: deps({ isStoreManaged: async () => true }),
    });
    const manual = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({
        id: 'in_manual',
        metadata: {
          type: 'kilo-pass-org',
          organizationId: 'org_manual',
          kiloUserId: 'user_1',
          tier: 'tier_49',
          cadence: 'monthly',
        },
      }),
      stripe: client,
      store,
      deps: deps({ getOrganizationPurchaseChannel: async () => 'manual' }),
    });
    const unknown = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({
        id: 'in_unknown',
        metadata: {},
        lines: [invoiceLine({ id: 'il_unknown', amount: 1_000 })],
      }),
      stripe: client,
      store,
      deps: deps(),
    });

    expect(auto.assessment).toBeNull();
    expect(orgAuto.assessment).toBeNull();
    expect(notDraft).toMatchObject({
      status: 'missed',
      assessment: { failureCode: 'invoice_not_draft', outcome: 'missed' },
    });
    expect(seats.assessment).toBeNull();
    expect(claw.assessment).toBeNull();
    expect(storeManaged.assessment).toBeNull();
    expect(manual.assessment).toBeNull();
    expect(unknown.assessment).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(await store.findByAssessmentKey(createInvoiceServiceFeeAssessmentKey('in_test'))).toBe(
      null
    );
  });

  test('exact organization exemption at invoice.created omits the fee line', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const findEffectiveExemption: NonNullable<
      KiloPassInvoiceCreatedDependencies['findEffectiveExemption']
    > = jest.fn(async () => ({ id: 'hist_exempt', isExempt: true }));

    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({
        metadata: {
          type: 'kilo-pass-org',
          organizationId: 'org_1',
          kiloUserId: 'user_1',
          tier: 'tier_49',
          cadence: 'monthly',
        },
      }),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        findEffectiveExemption,
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
        getOrganizationPurchaseChannel: async () => 'self_serve',
      }),
    });

    expect(findEffectiveExemption).toHaveBeenCalledWith('org_1', new Date(ACTIVATION * 1000));
    expect(result.assessment).toMatchObject({
      outcome: 'exempt',
      exemptionId: 'hist_exempt',
      expectedFeeMinor: 245,
      chargedFeeMinor: 0,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test('catch-all alert preserves organization flow from available metadata', async () => {
    const store = createMemoryAssessmentStore();
    const sendAlert: NonNullable<KiloPassInvoiceCreatedDependencies['sendAlert']> = jest.fn(
      async () => undefined
    );
    const metadata: Stripe.Metadata = {
      type: 'kilo-pass-org',
      organizationId: 'org_1',
      kiloUserId: 'user_1',
      tier: 'tier_49',
      cadence: 'monthly',
    };

    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({ metadata, has_more: true }),
      stripe: stripeClient({
        listLineItems: async () => {
          throw new Error('Stripe line listing unavailable');
        },
      }),
      store,
      deps: deps({ sendAlert }),
    });

    expect(result.status).toBe('skipped');
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: 'organization_kilo_pass',
        organizationId: 'org_1',
        kiloUserId: 'user_1',
      })
    );
  });

  test('tax resolution failure persists missed, alerts, and returns normally', async () => {
    const store = createMemoryAssessmentStore();
    const sendAlert: NonNullable<KiloPassInvoiceCreatedDependencies['sendAlert']> = jest.fn(
      async () => undefined
    );
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));

    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice(),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        sendAlert,
        resolveTaxInput: async () => {
          throw new Error(SERVICE_FEE_FAILURE_APPLICATION);
        },
      }),
    });

    expect(result.status).toBe('missed');
    expect(result.assessment).toMatchObject({
      outcome: 'missed',
      failureCode: SERVICE_FEE_FAILURE_APPLICATION,
      chargedFeeMinor: 0,
      expectedFeeMinor: 245,
    });
    expect(create).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: SERVICE_FEE_FAILURE_APPLICATION })
    );
  });

  test('injected available tax creates one non-discountable fee item with exact metadata and mirrored tax', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async (params: Stripe.InvoiceItemCreateParams) => {
      expect(params).toMatchObject({
        customer: 'cus_1',
        invoice: 'in_test',
        amount: 245,
        currency: 'usd',
        description: SERVICE_FEE_DESCRIPTION,
        discountable: false,
        tax_behavior: 'exclusive',
        metadata: {
          type: SERVICE_FEE_METADATA_TYPE,
          serviceFeeVersion: SERVICE_FEE_VERSION,
          serviceFeeAssessmentKey: createInvoiceServiceFeeAssessmentKey('in_test'),
          serviceFeeRateBasisPoints: String(SERVICE_FEE_RATE_BASIS_POINTS),
        },
      });
      return { id: 'ii_fee', amount: 245 };
    });

    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice(),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        resolveTaxInput: async () => ({
          source: 'price',
          taxBehavior: 'exclusive',
        }),
      }),
    });

    expect(result.status).toBe('charged');
    expect(result.assessment).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 245,
      stripeInvoiceId: 'in_test',
      stripeInvoiceFeeLineItemId: 'ii_fee',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('reuses a prepared synchronous assessment key without racing its attachment owner', async () => {
    const store = createMemoryAssessmentStore();
    const preparedKey = 'seat-capacity:sub_org:1788220800:12';
    const organizationId = '00000000-0000-4000-8000-000000000001';
    const decision = await prepareServiceFeeAssessmentDecision({
      assessmentKey: preparedKey,
      flow: 'organization_kilo_pass',
      currency: 'usd',
      eligibilityCreatedAt: new Date(ACTIVATION * 1000),
      eligibleSubtotalMinor: 4_900,
      kiloUserId: 'user_1',
      organizationId,
      stripeCustomerId: 'cus_1',
    });
    await upsertServiceFeeAssessment({ store, decision });
    const create = jest.fn(async () => ({ id: 'ii_prepared', amount: 245 }));
    const invoice = draftInvoice({
      parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: {
          metadata: {
            type: 'kilo-pass-org',
            organizationId,
            kiloUserId: 'user_1',
            tier: 'tier_49',
            cadence: 'monthly',
            serviceFeeAssessmentKey: preparedKey,
          },
          subscription: 'sub_1',
        },
      },
    });

    const result = await handleKiloPassInvoiceCreated({
      invoice,
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      }),
    });

    expect(result).toMatchObject({ status: 'assessed' });
    expect(result.assessment?.assessmentKey).toBe(preparedKey);
    expect(
      await store.findByAssessmentKey(createInvoiceServiceFeeAssessmentKey('in_test'))
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test('does not attach a non-invoice synchronous key when its row is not visible yet', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async () => ({ id: 'ii_race', amount: 245 }));
    const invoice = draftInvoice({
      parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: {
          metadata: {
            ...personalMetadata(),
            serviceFeeAssessmentKey: 'org-checkout:not-visible-yet',
          },
          subscription: 'sub_1',
        },
      },
    });

    const result = await handleKiloPassInvoiceCreated({
      invoice,
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      }),
    });

    expect(result).toMatchObject({ status: 'skipped', assessment: null });
    expect(create).not.toHaveBeenCalled();
  });

  test('duplicate retry does not attach a second fee and missed is never recollected', async () => {
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const availableTax = deps({
      resolveTaxInput: async () => ({ source: 'inline_inherit' }),
    });

    const first = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice(),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: availableTax,
    });
    const second = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice(),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: availableTax,
    });

    expect(first.assessment?.assessmentKey).toBe(second.assessment?.assessmentKey);
    expect(create).toHaveBeenCalledTimes(1);

    const missedStore = createMemoryAssessmentStore();
    const missedCreate = jest.fn(async () => ({ id: 'ii_later', amount: 245 }));
    const missed = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({ id: 'in_missed' }),
      stripe: stripeClient({ createInvoiceItem: { create: missedCreate } }),
      store: missedStore,
      deps: deps({
        resolveTaxInput: async () => {
          throw new Error(SERVICE_FEE_FAILURE_APPLICATION);
        },
      }),
    });
    const retry = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice({ id: 'in_missed' }),
      stripe: stripeClient({ createInvoiceItem: { create: missedCreate } }),
      store: missedStore,
      deps: availableTax,
    });

    expect(missed.assessment?.outcome).toBe('missed');
    expect(retry.assessment?.outcome).toBe('missed');
    expect(missedCreate).not.toHaveBeenCalled();
  });

  test('attach failure and Slack failure both fail open', async () => {
    const store = createMemoryAssessmentStore();
    const sendAlert = jest.fn(async () => {
      throw new Error('slack_down');
    });
    const create = jest.fn(async () => {
      throw new Error('Stripe invoice item failed');
    });

    const result = await handleKiloPassInvoiceCreated({
      invoice: draftInvoice(),
      stripe: stripeClient({ createInvoiceItem: { create } }),
      store,
      deps: deps({
        sendAlert,
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      }),
    });

    expect(result.status).toBe('missed');
    expect(result.assessment).toMatchObject({
      outcome: 'missed',
      failureCode: SERVICE_FEE_FAILURE_APPLICATION,
      chargedFeeMinor: 0,
    });
    expect(sendAlert).toHaveBeenCalled();
  });
});
