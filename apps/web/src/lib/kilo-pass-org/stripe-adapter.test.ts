import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type Stripe from 'stripe';
import { SEAT_PRODUCT_IDS } from '@kilocode/web-shared/lib/organizations/stripe-seat-line-items';
import {
  markServiceFeeAssessmentCharged,
  markServiceFeeAssessmentMissed,
  prepareServiceFeeAssessmentDecision,
  upsertServiceFeeAssessment,
  type ServiceFeeAssessmentRecord,
  type ServiceFeeAssessmentStore,
} from '@kilocode/web-shared/lib/service-fees/assessments';
import {
  SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
  SERVICE_FEE_DESCRIPTION,
  SERVICE_FEE_METADATA_TYPE,
  SERVICE_FEE_RATE_BASIS_POINTS,
  SERVICE_FEE_VERSION,
} from '@kilocode/web-shared/lib/service-fees/constants';
import {
  createInvoiceServiceFeeAssessmentKey,
  SERVICE_FEE_FAILURE_APPLICATION,
} from '@kilocode/web-shared/lib/service-fees/checkout';
import type { KiloPassInvoiceCreatedDependencies } from '@/lib/service-fees/invoice-created';
import { buildServiceFeeLineMetadata } from '@kilocode/web-shared/lib/service-fees/stripe-lines';
import type { KiloPassServiceFeeSettlementStripe } from '@/lib/service-fees/settlement';
import type { OrganizationKiloPassSeatCapacityStripe } from '@/lib/kilo-pass-org/stripe-adapter';

const retrieve =
  jest.fn<
    (id: string, params?: Stripe.SubscriptionRetrieveParams) => Promise<Stripe.Subscription>
  >();
const update =
  jest.fn<(id: string, input: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription>>();
const scheduleCreate = jest.fn<(input: unknown) => Promise<Stripe.SubscriptionSchedule>>();
const scheduleUpdate = jest.fn<(id: string, input: unknown) => Promise<unknown>>();
const scheduleRetrieve = jest.fn<(id: string) => Promise<Stripe.SubscriptionSchedule>>();
const scheduleRelease = jest.fn<(id: string) => Promise<Stripe.SubscriptionSchedule>>();
const captureMessage = jest.fn();
const warnExceptInTest = jest.fn();
const invoicePaymentsList =
  jest.fn<
    (params: Stripe.InvoicePaymentListParams) => Promise<Stripe.ApiList<Stripe.InvoicePayment>>
  >();
const invoiceItemCreate =
  jest.fn<
    (params: Stripe.InvoiceItemCreateParams) => Promise<Pick<Stripe.InvoiceItem, 'id' | 'amount'>>
  >();
const invoiceItemDel = jest.fn<(id: string) => Promise<unknown>>();

function createdInvoiceItemAssessmentKey(): string | undefined {
  const metadata = invoiceItemCreate.mock.calls[0]?.[0]?.metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = metadata.serviceFeeAssessmentKey;
  return typeof value === 'string' ? value : undefined;
}
const listLineItems =
  jest.fn<
    (
      invoiceId: string,
      params?: Stripe.InvoiceListLineItemsParams
    ) => Promise<Pick<Stripe.ApiList<Stripe.InvoiceLineItem>, 'data' | 'has_more'>>
  >();
const createPreview =
  jest.fn<
    (
      params: Stripe.InvoiceCreatePreviewParams
    ) => Promise<
      Pick<Stripe.Invoice, 'id' | 'currency' | 'customer' | 'created' | 'status' | 'lines'>
    >
  >();
const select = jest.fn();
const selectOrderBy = jest.fn();
const updateDb = jest.fn();
const updateSet = jest.fn();
const activatePaidAgreement = jest.fn();
const createParentSupplement = jest.fn();
const createPendingAgreement =
  jest.fn<(input: unknown) => Promise<{ agreementId: string; created: boolean }>>();
const bindProviderSeatAddOnItem = jest.fn();
const endAgreementAfterPassItemRemoved = jest.fn();

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  client: {
    subscriptions: { retrieve, update },
    invoicePayments: { list: invoicePaymentsList },
    invoiceItems: { create: invoiceItemCreate, del: invoiceItemDel },
    invoices: { listLineItems, createPreview },
    subscriptionSchedules: {
      create: scheduleCreate,
      update: scheduleUpdate,
      retrieve: scheduleRetrieve,
      release: scheduleRelease,
    },
  },
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/utils.server');
  return {
    ...(actual as object),
    warnExceptInTest: (...args: unknown[]) => warnExceptInTest(...args),
  };
});
jest.mock('@sentry/nextjs', () => {
  const actual = jest.requireActual('@sentry/nextjs');
  return { ...(actual as object), captureMessage: (...args: unknown[]) => captureMessage(...args) };
});
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => select(...args),
    update: (...args: unknown[]) => updateDb(...args),
  },
}));
jest.mock('./service', () => ({
  activatePaidAgreement,
  bindProviderSeatAddOnItem,
  createParentSupplement,
  createPendingAgreement,
  endAgreementAfterPassItemRemoved,
  suspendAgreementForPaymentReview: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/kilo-pass/stripe-price-ids.server', () => ({
  getKnownStripePriceIdsForKiloPass: () => ['price_pass'],
  getStripePriceIdForKiloPass: () => 'price_pass',
}));
jest.mock('@kilocode/web-shared/lib/organizations/stripe-seat-line-items', () => {
  const actual = jest.requireActual(
    '@kilocode/web-shared/lib/organizations/stripe-seat-line-items'
  ) as {
    isSeatLineItem: (item: { id: string }) => boolean;
    SEAT_PRODUCT_IDS: Set<string>;
  };
  return {
    ...actual,
    isSeatLineItem: (item: { id: string }) => item.id === 'si_seat',
  };
});

const subscription = (overrides: Partial<Stripe.Subscription> = {}) =>
  ({
    id: 'sub_1',
    metadata: {
      type: 'kilo-pass-org',
      organizationId: 'org_1',
      kiloUserId: 'user_1',
      tier: 'tier_19',
      cadence: 'monthly',
    },
    status: 'active',
    cancel_at_period_end: false,
    schedule: null,
    items: {
      data: [
        {
          id: 'si_seat',
          quantity: 9,
          price: { id: 'price_seat', recurring: { interval: 'month' } },
          current_period_start: 1_767_225_600,
          current_period_end: 1_769_904_000,
        },
        {
          id: 'si_pass',
          quantity: 9,
          price: { id: 'price_pass', recurring: { interval: 'month' } },
          current_period_start: 1_767_225_600,
          current_period_end: 1_769_904_000,
        },
      ],
    },
    ...overrides,
  }) as unknown as Stripe.Subscription;

const PERIOD_START = 1_767_225_600;
const PERIOD_END = 1_769_904_000;
const NEXT_PERIOD_END = 1_772_582_400;
const CURRENT_ITEMS = [
  { price: 'price_seat', quantity: 9 },
  { price: 'price_pass', quantity: 9 },
];
const RETAINED_ITEMS = [{ price: 'price_seat', quantity: 9 }];

function schedulePhase(
  start: number,
  end: number,
  items: { price: string; quantity: number }[],
  overrides: Record<string, unknown> = {}
) {
  return { start_date: start, end_date: end, items, ...overrides };
}

const schedule = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'sched_cancel',
    object: 'subscription_schedule',
    status: 'active',
    metadata: { origin: 'kilo-pass-org-cancellation', agreementId: 'agreement_1' },
    current_phase: { start_date: PERIOD_START, end_date: PERIOD_END },
    phases: [schedulePhase(PERIOD_START, PERIOD_END, CURRENT_ITEMS)],
    ...overrides,
  }) as unknown as Stripe.SubscriptionSchedule;

const removalPendingSchedule = (overrides: Record<string, unknown> = {}) =>
  schedule({
    phases: [
      schedulePhase(PERIOD_START, PERIOD_END, CURRENT_ITEMS),
      schedulePhase(PERIOD_END, NEXT_PERIOD_END, RETAINED_ITEMS),
    ],
    ...overrides,
  });

function dbAgreement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agreement_1',
    provider_subscription_id: 'sub_1',
    provider_seat_add_on_item_id: 'si_pass',
    purchased_pass_capacity: 3,
    issuance_anchor_at: '2026-01-01T00:00:00.000Z',
    state: 'active',
    processing_condition: 'ready',
    ...overrides,
  };
}

describe('organization Kilo Pass Stripe adapter', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    const rows = [dbAgreement()];
    selectOrderBy.mockReturnValue({ limit: async () => rows });
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => rows,
          orderBy: selectOrderBy,
        }),
      }),
    });
    updateSet.mockReturnValue({ where: async () => undefined });
    updateDb.mockReturnValue({ set: updateSet });
    invoicePaymentsList.mockResolvedValue({
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/invoice_payments',
    });
    listLineItems.mockResolvedValue({ data: [], has_more: false });
    invoiceItemCreate.mockResolvedValue({ id: 'ii_fee', amount: 245 });
    invoiceItemDel.mockResolvedValue({});
  });

  test('derives paid capacity and bridge issuance window from immutable invoice lines', async () => {
    retrieve.mockResolvedValue(subscription());
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_pass',
            quantity: 2,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
          {
            id: 'line_seat',
            quantity: 5,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_seat' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

    await expect(handleOrganizationKiloPassInvoicePaid({ invoice })).resolves.toBe(true);
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({
        paidSeatCount: 5,
        paidFrom: new Date('2026-01-04T12:00:00.000Z'),
        paidUntil: new Date('2026-02-01T00:00:00.000Z'),
        firstWindow: {
          start: new Date('2026-01-01T00:00:00.000Z'),
          end: new Date('2026-02-01T00:00:00.000Z'),
        },
        paidBridgeInterval: {
          start: new Date('2026-01-04T12:00:00.000Z'),
          end: new Date('2026-02-01T00:00:00.000Z'),
        },
        isBridge: true,
      })
    );
    expect(createParentSupplement).toHaveBeenCalledWith(
      expect.objectContaining({ paidSeatCount: 5 })
    );
  });

  test('activates an add-on-only invoice from immutable pending capacity', async () => {
    const rows = [dbAgreement({ state: 'pending_payment' })];
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => rows,
          orderBy: () => ({ limit: async () => rows }),
        }),
      }),
    });
    retrieve.mockResolvedValue(subscription());
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_pass',
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

    await expect(handleOrganizationKiloPassInvoicePaid({ invoice })).resolves.toBe(true);
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ paidSeatCount: 3 })
    );
  });

  test('uses the paid post-update capacity when a seat-increase invoice omits the seat line', async () => {
    retrieve.mockResolvedValue(
      subscription({
        items: {
          data: [
            {
              id: 'si_seat',
              quantity: 15,
              price: { id: 'price_seat', recurring: { interval: 'month' } },
            },
            {
              id: 'si_pass',
              quantity: 15,
              price: { id: 'price_pass', recurring: { interval: 'month' } },
            },
          ],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      })
    );
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_pass_second_increase',
            quantity: 5,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

    await expect(
      handleOrganizationKiloPassInvoicePaid({ invoice, paidSeatCount: 15 })
    ).resolves.toBe(true);

    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ paidSeatCount: 15 })
    );
    expect(createParentSupplement).toHaveBeenCalledWith(
      expect.objectContaining({
        paidSeatCount: 15,
        providerInvoiceLineId: 'line_pass_second_increase',
      })
    );
  });

  test('uses the current subscription quantity when a later webhook omits the seat line', async () => {
    retrieve.mockResolvedValue(
      subscription({
        items: {
          data: [
            {
              id: 'si_seat',
              quantity: 22,
              price: { id: 'price_seat', recurring: { interval: 'month' } },
            },
            {
              id: 'si_pass',
              quantity: 22,
              price: { id: 'price_pass', recurring: { interval: 'month' } },
            },
          ],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      })
    );
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_pass_webhook',
            quantity: 2,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

    await expect(handleOrganizationKiloPassInvoicePaid({ invoice })).resolves.toBe(true);

    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ paidSeatCount: 22 })
    );
  });

  test('ignores unused-time proration quantity when remaining time is also on the invoice', async () => {
    retrieve.mockResolvedValue(
      subscription({
        items: {
          data: [
            {
              id: 'si_seat',
              quantity: 2,
              price: { id: 'price_seat', recurring: { interval: 'month' } },
            },
            {
              id: 'si_pass',
              quantity: 2,
              price: { id: 'price_pass', recurring: { interval: 'month' } },
            },
          ],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      })
    );
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_seat_unused',
            amount: -1_798,
            quantity: 1,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_seat' } },
          },
          {
            id: 'line_pass_unused',
            amount: -1_898,
            quantity: 1,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
          {
            id: 'line_seat_remaining',
            amount: 3_595,
            quantity: 2,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_seat' } },
          },
          {
            id: 'line_pass_remaining',
            amount: 3_795,
            quantity: 2,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

    await expect(handleOrganizationKiloPassInvoicePaid({ invoice })).resolves.toBe(true);
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ paidSeatCount: 2 })
    );
  });

  test('returns a PaymentIntent client secret for payment authentication', async () => {
    retrieve.mockResolvedValue(
      subscription({ items: { ...subscription().items, data: [subscription().items.data[0]!] } })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    update.mockResolvedValue({
      ...subscription(),
      latest_invoice: {
        id: 'in_action',
        status: 'open',
        confirmation_secret: { type: 'payment_intent', client_secret: 'pi_secret_1' },
      } as unknown as Stripe.Invoice,
    });
    invoicePaymentsList.mockResolvedValue({
      object: 'list',
      data: [
        {
          status: 'open',
          payment: {
            type: 'payment_intent',
            payment_intent: { status: 'requires_action' },
          },
        } as unknown as Stripe.InvoicePayment,
      ],
      has_more: false,
      url: '/v1/invoice_payments',
    });
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).resolves.toEqual({ kind: 'payment_action', clientSecret: 'pi_secret_1' });
    expect(update).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({
        payment_behavior: 'allow_incomplete',
        proration_behavior: 'always_invoice',
        expand: ['latest_invoice.confirmation_secret', 'latest_invoice.lines'],
      })
    );
    expect(invoicePaymentsList).toHaveBeenCalledWith({
      invoice: 'in_action',
      status: 'open',
      payment: { type: 'payment_intent' },
      expand: ['data.payment.payment_intent'],
      limit: 10,
    });
    expect(selectOrderBy).toHaveBeenCalledTimes(1);
  });

  test('rejects an ended seat subscription before creating a pending agreement', async () => {
    retrieve.mockResolvedValue(
      subscription({
        status: 'canceled',
        ended_at: 1_776_120_000,
        items: { ...subscription().items, data: [subscription().items.data[0]!] },
      })
    );
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).rejects.toThrow('An active organization seat subscription is required');
    expect(createPendingAgreement).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('does not request a browser action after a hard payment decline', async () => {
    retrieve.mockResolvedValue(
      subscription({ items: { ...subscription().items, data: [subscription().items.data[0]!] } })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    update.mockResolvedValue({
      ...subscription(),
      latest_invoice: {
        id: 'in_declined',
        status: 'open',
        confirmation_secret: { type: 'payment_intent', client_secret: 'pi_secret_1' },
      } as unknown as Stripe.Invoice,
    });
    invoicePaymentsList.mockResolvedValue({
      object: 'list',
      data: [
        {
          status: 'open',
          payment: {
            type: 'payment_intent',
            payment_intent: { status: 'requires_payment_method' },
          },
        } as unknown as Stripe.InvoicePayment,
      ],
      has_more: false,
      url: '/v1/invoice_payments',
    });
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).resolves.toEqual({ kind: 'pending' });
  });

  test('keeps checkout pending when invoice payment lookup is unavailable', async () => {
    retrieve.mockResolvedValue(
      subscription({ items: { ...subscription().items, data: [subscription().items.data[0]!] } })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    update.mockResolvedValue({
      ...subscription(),
      latest_invoice: {
        id: 'in_lookup_failure',
        status: 'open',
        confirmation_secret: { type: 'payment_intent', client_secret: 'pi_secret_1' },
      } as unknown as Stripe.Invoice,
    });
    invoicePaymentsList.mockRejectedValue(new Error('provider unavailable'));
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).resolves.toEqual({ kind: 'pending' });
  });

  test('refuses checkout when the seat subscription already has a pass add-on', async () => {
    retrieve.mockResolvedValue(subscription());
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).rejects.toThrow('KILO_PASS_ORG_ALREADY_EXISTS');
    expect(createPendingAgreement).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('refuses checkout when agreement creation finds a concurrent non-ended agreement', async () => {
    retrieve.mockResolvedValue(
      subscription({ items: { ...subscription().items, data: [subscription().items.data[0]!] } })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: false });
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).rejects.toThrow('KILO_PASS_ORG_ALREADY_EXISTS');
    expect(update).not.toHaveBeenCalled();
  });

  test('releases a stale owned schedule before adding the pass at checkout', async () => {
    const seatOnlyItems = { ...subscription().items, data: [subscription().items.data[0]!] };
    const staleSchedule = schedule({
      phases: [
        schedulePhase(PERIOD_START, PERIOD_END, RETAINED_ITEMS),
        schedulePhase(PERIOD_END, NEXT_PERIOD_END, RETAINED_ITEMS),
      ],
    });
    retrieve.mockResolvedValue(subscription({ items: seatOnlyItems, schedule: staleSchedule }));
    scheduleRelease.mockResolvedValue({ ...staleSchedule, status: 'released' });
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    update.mockResolvedValue({ ...subscription(), latest_invoice: null });
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await createOrganizationKiloPassCheckout({
      organizationId: 'org_1',
      actorUserId: 'user_1',
      tier: 'tier_19',
      allocations: [],
    });

    expect(scheduleRelease).toHaveBeenCalledWith('sched_cancel');
    expect(scheduleRelease.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!
    );
  });

  test('refuses checkout without changes when a foreign schedule is attached', async () => {
    retrieve.mockResolvedValue(
      subscription({
        items: { ...subscription().items, data: [subscription().items.data[0]!] },
        schedule: schedule({
          metadata: { origin: 'billing-cycle-change' },
          phases: [schedulePhase(PERIOD_START, PERIOD_END, RETAINED_ITEMS)],
        }),
      })
    );
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).rejects.toMatchObject({ reason: 'schedule_conflict' });
    expect(scheduleRelease).not.toHaveBeenCalled();
    expect(createPendingAgreement).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: expect.objectContaining({ event: 'checkout', reason: 'unowned_schedule' }),
      })
    );
  });

  test('fails checkout closed with a typed, reported error when the schedule cannot be read', async () => {
    retrieve.mockResolvedValue(
      subscription({
        items: { ...subscription().items, data: [subscription().items.data[0]!] },
        schedule: 'sched_unreadable',
      })
    );
    scheduleRetrieve.mockRejectedValue(
      Object.assign(new Error('Request req_1 for cus_secret failed'), {
        type: 'StripeConnectionError',
        code: 'connection_error',
      })
    );
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).rejects.toMatchObject({ reason: 'schedule_unavailable' });

    const expectedDetails = expect.objectContaining({
      event: 'checkout',
      reason: 'schedule_read_failed',
      organizationId: 'org_1',
      subscriptionId: 'sub_1',
      failure: { name: 'Error', type: 'StripeConnectionError', code: 'connection_error' },
    });
    expect(captureMessage).toHaveBeenCalledWith(expect.any(String), {
      level: 'warning',
      tags: {
        source: 'kilo_pass_org_schedule',
        event: 'checkout',
        reason: 'schedule_read_failed',
      },
      extra: expectedDetails,
    });
    expect(warnExceptInTest).toHaveBeenCalledWith(expect.any(String), expectedDetails);
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain('cus_secret');
    expect(scheduleRelease).not.toHaveBeenCalled();
    expect(createPendingAgreement).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('fails checkout closed with a typed, reported error when release fails', async () => {
    const seatOnlyItems = { ...subscription().items, data: [subscription().items.data[0]!] };
    const staleSchedule = schedule({
      phases: [schedulePhase(PERIOD_START, PERIOD_END, RETAINED_ITEMS)],
    });
    retrieve.mockResolvedValue(subscription({ items: seatOnlyItems, schedule: staleSchedule }));
    scheduleRelease.mockRejectedValue(
      Object.assign(new Error('timeout'), { type: 'StripeAPIError' })
    );
    scheduleRetrieve.mockResolvedValue(staleSchedule);
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).rejects.toMatchObject({ reason: 'schedule_unavailable' });

    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'schedule_release_failed' }),
        extra: expect.objectContaining({
          organizationId: 'org_1',
          subscriptionId: 'sub_1',
          scheduleId: 'sched_cancel',
          phases: [
            {
              start_date: PERIOD_START,
              end_date: PERIOD_END,
              items: RETAINED_ITEMS,
            },
          ],
          failure: { name: 'Error', type: 'StripeAPIError' },
        }),
      })
    );
    expect(createPendingAgreement).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('reconciles the add-on item when invoice.paid arrives before checkout binding', async () => {
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [
            dbAgreement({
              state: 'pending_payment',
              provider_seat_add_on_item_id: 'pending:sub_1',
            }),
          ],
          orderBy: () => ({
            limit: async () => [
              dbAgreement({
                state: 'pending_payment',
                provider_seat_add_on_item_id: 'pending:sub_1',
              }),
            ],
          }),
        }),
      }),
    });
    retrieve.mockResolvedValue(subscription());
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_pass',
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

    await expect(handleOrganizationKiloPassInvoicePaid({ invoice })).resolves.toBe(true);
    expect(bindProviderSeatAddOnItem).toHaveBeenCalledWith({
      agreementId: 'agreement_1',
      providerSeatAddOnItemId: 'si_pass',
    });
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ agreementId: 'agreement_1' })
    );
  });

  test('returns completed instead of an empty checkout URL for a zero-due update', async () => {
    retrieve.mockResolvedValue(
      subscription({ items: { ...subscription().items, data: [subscription().items.data[0]!] } })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    update.mockResolvedValue({
      ...subscription(),
      latest_invoice: {
        status: 'paid',
        amount_due: 0,
        parent: { subscription_details: { subscription: 'sub_1' } },
        lines: {
          data: [
            {
              id: 'line_pass',
              period: { start: 1_767_528_000, end: 1_769_904_000 },
              parent: { subscription_item_details: { subscription_item: 'si_pass' } },
            },
          ],
        },
      } as unknown as Stripe.Invoice,
    });
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
      })
    ).resolves.toEqual({ kind: 'completed' });
    expect(bindProviderSeatAddOnItem).toHaveBeenCalledWith({
      agreementId: 'agreement_1',
      providerSeatAddOnItemId: 'si_pass',
    });
  });

  test('reconciles a paid latest invoice for a pending agreement', async () => {
    const invoice = {
      status: 'paid',
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_pass',
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    select
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [{ providerSubscriptionId: 'sub_1' }] }),
          }),
        }),
      })
      .mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [dbAgreement({ state: 'pending_payment' })],
            orderBy: () => ({ limit: async () => [dbAgreement({ state: 'pending_payment' })] }),
          }),
        }),
      });
    retrieve
      .mockResolvedValueOnce(subscription({ latest_invoice: invoice }))
      .mockResolvedValueOnce(subscription());
    const { reconcileOrganizationKiloPassPayment } = await import('./stripe-adapter');

    await expect(reconcileOrganizationKiloPassPayment('org_1')).resolves.toBe(true);
    expect(retrieve).toHaveBeenNthCalledWith(1, 'sub_1', { expand: ['latest_invoice'] });
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ agreementId: 'agreement_1' })
    );
  });

  test('ends a pending agreement when its seat subscription has ended without a pass invoice', async () => {
    const rows = [{ id: 'agreement_1', providerSubscriptionId: 'sub_1' }];
    select.mockReturnValue({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => rows }) }),
      }),
    });
    retrieve.mockResolvedValue(
      subscription({
        status: 'canceled',
        ended_at: 1_776_120_000,
        latest_invoice: {
          status: 'paid',
          parent: { subscription_details: { subscription: 'sub_1' } },
          lines: { data: [] },
        } as unknown as Stripe.Invoice,
      })
    );
    const { reconcileOrganizationKiloPassPayment } = await import('./stripe-adapter');

    await expect(reconcileOrganizationKiloPassPayment('org_1')).resolves.toBe(true);
    expect(updateSet).toHaveBeenCalledWith({ state: 'ended' });
  });

  test('does not grant a supplement while payment review suspends issuance', async () => {
    const suspended = dbAgreement({ processing_condition: 'suspended_for_review' });
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => [suspended] }),
        }),
      }),
    });
    retrieve.mockResolvedValue(subscription());
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_pass',
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

    await expect(
      handleOrganizationKiloPassInvoicePaid({ invoice, paidSeatCount: 9 })
    ).resolves.toBe(true);
    expect(activatePaidAgreement).toHaveBeenCalled();
    expect(createParentSupplement).not.toHaveBeenCalled();
  });

  test('schedules removal of only the pass item at the paid period end', async () => {
    retrieve.mockResolvedValue(subscription());
    scheduleCreate.mockResolvedValue(schedule({ id: 'sub_sched_1', metadata: {} }));
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    });

    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: 'sub_1' });
    expect(scheduleUpdate).toHaveBeenCalledWith('sub_sched_1', {
      metadata: { origin: 'kilo-pass-org-cancellation', agreementId: 'agreement_1' },
      end_behavior: 'release',
      phases: [
        { items: CURRENT_ITEMS, start_date: PERIOD_START, end_date: PERIOD_END },
        { items: RETAINED_ITEMS },
      ],
    });
  });

  test('repairs a leaked one-phase owned schedule instead of creating another', async () => {
    retrieve.mockResolvedValue(subscription({ schedule: schedule() }));
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    });

    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sched_cancel',
      expect.objectContaining({
        phases: [
          expect.objectContaining({
            items: CURRENT_ITEMS,
            start_date: PERIOD_START,
            end_date: PERIOD_END,
          }),
          expect.objectContaining({ items: RETAINED_ITEMS }),
        ],
      })
    );
  });

  test('ignores an ended historical phase when rewriting an owned schedule', async () => {
    const previousStart = PERIOD_START - 2_678_400;
    retrieve.mockResolvedValue(
      subscription({
        schedule: schedule({
          phases: [
            schedulePhase(previousStart, PERIOD_START, [
              { price: 'price_seat', quantity: 5 },
              { price: 'price_pass', quantity: 5 },
            ]),
            schedulePhase(PERIOD_START, PERIOD_END, CURRENT_ITEMS),
          ],
        }),
      })
    );
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    });

    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sched_cancel',
      expect.objectContaining({
        phases: [
          expect.objectContaining({ start_date: PERIOD_START, end_date: PERIOD_END }),
          expect.objectContaining({ items: RETAINED_ITEMS }),
        ],
      })
    );
  });

  test('preserves the later active phase after the subscription has renewed', async () => {
    const renewedSchedule = schedule({
      current_phase: { start_date: PERIOD_END, end_date: NEXT_PERIOD_END },
      phases: [
        schedulePhase(PERIOD_START, PERIOD_END, CURRENT_ITEMS),
        schedulePhase(PERIOD_END, NEXT_PERIOD_END, CURRENT_ITEMS),
      ],
    });
    const renewed = subscription({ schedule: renewedSchedule });
    renewed.items.data.forEach(item => {
      item.current_period_start = PERIOD_END;
      item.current_period_end = NEXT_PERIOD_END;
    });
    retrieve.mockResolvedValue(renewed);
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    });

    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sched_cancel',
      expect.objectContaining({
        phases: [
          expect.objectContaining({ start_date: PERIOD_END, end_date: NEXT_PERIOD_END }),
          expect.objectContaining({ items: RETAINED_ITEMS }),
        ],
      })
    );
  });

  test('re-sends supported phase settings so the rewrite only changes items', async () => {
    retrieve.mockResolvedValue(
      subscription({
        schedule: schedule({
          phases: [
            schedulePhase(PERIOD_START, PERIOD_END, CURRENT_ITEMS, {
              collection_method: 'send_invoice',
              default_tax_rates: [{ id: 'txr_1' }],
              discounts: [{ discount: 'di_1', coupon: null, promotion_code: null }],
              invoice_settings: { account_tax_ids: null, days_until_due: 14, issuer: null },
            }),
          ],
        }),
      })
    );
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    });

    const preserved = {
      collection_method: 'send_invoice',
      default_tax_rates: ['txr_1'],
      discounts: [{ discount: 'di_1' }],
      invoice_settings: { days_until_due: 14 },
    };
    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sched_cancel',
      expect.objectContaining({
        phases: [
          expect.objectContaining({ items: CURRENT_ITEMS, ...preserved }),
          expect.objectContaining({ items: RETAINED_ITEMS, ...preserved }),
        ],
      })
    );
  });

  test('keeps explicitly empty discounts and tax rates so a rewrite cannot inherit defaults', async () => {
    retrieve.mockResolvedValue(
      subscription({
        schedule: schedule({
          phases: [
            schedulePhase(
              PERIOD_START,
              PERIOD_END,
              CURRENT_ITEMS.map(item => ({ ...item, discounts: [], tax_rates: [] })),
              { discounts: [], default_tax_rates: [] }
            ),
          ],
        }),
      })
    );
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    });

    const clearedItem = { discounts: '', tax_rates: '' };
    const clearedPhase = { discounts: '', default_tax_rates: '' };
    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sched_cancel',
      expect.objectContaining({
        phases: [
          {
            start_date: PERIOD_START,
            end_date: PERIOD_END,
            items: CURRENT_ITEMS.map(item => ({ ...item, ...clearedItem })),
            ...clearedPhase,
          },
          { items: RETAINED_ITEMS.map(item => ({ ...item, ...clearedItem })), ...clearedPhase },
        ],
      })
    );
  });

  test('adopts a safe orphaned from-subscription schedule after an update failure', async () => {
    retrieve.mockResolvedValue(
      subscription({ schedule: schedule({ id: 'sched_orphaned', metadata: {} }) })
    );
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    });

    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sched_orphaned',
      expect.objectContaining({
        metadata: { origin: 'kilo-pass-org-cancellation', agreementId: 'agreement_1' },
      })
    );
  });

  test('leaves an already pending owned removal untouched', async () => {
    retrieve.mockResolvedValue(subscription({ schedule: removalPendingSchedule() }));
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    });

    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
  });

  test('rejects and reports a matching single-phase schedule with foreign metadata', async () => {
    retrieve.mockResolvedValue(
      subscription({
        schedule: schedule({ id: 'sched_foreign', metadata: { supportTicket: 'SUP-1' } }),
      })
    );
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await expect(
      scheduleOrganizationKiloPassCancellation({
        providerSubscriptionId: 'sub_1',
        providerSeatAddOnItemId: 'si_pass',
        organizationId: 'org_1',
        agreementId: 'agreement_1',
      })
    ).rejects.toThrow('SCHEDULE_REWRITE_UNSAFE');
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(
      'Organization Kilo Pass subscription schedule cannot be changed safely',
      expect.objectContaining({
        tags: expect.objectContaining({ event: 'cancel', reason: 'unowned_schedule' }),
        extra: expect.objectContaining({
          organizationId: 'org_1',
          subscriptionId: 'sub_1',
          scheduleId: 'sched_foreign',
        }),
      })
    );
  });

  test('rejects an owned schedule without a current phase', async () => {
    retrieve.mockResolvedValue(subscription({ schedule: schedule({ current_phase: null }) }));
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await expect(
      scheduleOrganizationKiloPassCancellation({
        providerSubscriptionId: 'sub_1',
        providerSeatAddOnItemId: 'si_pass',
        organizationId: 'org_1',
        agreementId: 'agreement_1',
      })
    ).rejects.toThrow('SCHEDULE_REWRITE_UNSAFE');
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: expect.objectContaining({ event: 'cancel', reason: 'no_active_phase' }),
      })
    );
  });

  test('rejects an owned schedule whose removal phase carries a different seat quantity', async () => {
    retrieve.mockResolvedValue(
      subscription({
        schedule: removalPendingSchedule({
          phases: [
            schedulePhase(PERIOD_START, PERIOD_END, CURRENT_ITEMS),
            schedulePhase(PERIOD_END, NEXT_PERIOD_END, [{ price: 'price_seat', quantity: 12 }]),
          ],
        }),
      })
    );
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await expect(
      scheduleOrganizationKiloPassCancellation({
        providerSubscriptionId: 'sub_1',
        providerSeatAddOnItemId: 'si_pass',
        organizationId: 'org_1',
        agreementId: 'agreement_1',
      })
    ).rejects.toThrow('SCHEDULE_REWRITE_UNSAFE');
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'phase_items_mismatch' }),
      })
    );
  });

  test('rejects an owned schedule with phase settings a rewrite would drop', async () => {
    retrieve.mockResolvedValue(
      subscription({
        schedule: schedule({
          phases: [
            schedulePhase(PERIOD_START, PERIOD_END, CURRENT_ITEMS, { trial_end: PERIOD_END }),
          ],
        }),
      })
    );
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await expect(
      scheduleOrganizationKiloPassCancellation({
        providerSubscriptionId: 'sub_1',
        providerSeatAddOnItemId: 'si_pass',
        organizationId: 'org_1',
        agreementId: 'agreement_1',
      })
    ).rejects.toThrow('SCHEDULE_REWRITE_UNSAFE');
    expect(scheduleUpdate).not.toHaveBeenCalled();
  });

  test('fails closed instead of mistaking a billing-cycle schedule for pass removal', async () => {
    retrieve.mockResolvedValue(
      subscription({
        schedule: schedule({
          id: 'sched_cycle',
          metadata: { origin: 'billing-cycle-change' },
          phases: [
            schedulePhase(PERIOD_START, PERIOD_END, [{ price: 'price_pass', quantity: 9 }]),
            schedulePhase(PERIOD_END, NEXT_PERIOD_END, [
              { price: 'price_pass_yearly', quantity: 9 },
            ]),
          ],
        }),
      })
    );
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await expect(
      scheduleOrganizationKiloPassCancellation({
        providerSubscriptionId: 'sub_1',
        providerSeatAddOnItemId: 'si_pass',
        organizationId: 'org_1',
        agreementId: 'agreement_1',
      })
    ).rejects.toThrow('SCHEDULE_REWRITE_UNSAFE');
    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
  });

  test('resumes by releasing the owned schedule, and a later cancel schedules a fresh removal', async () => {
    const { resumeOrganizationKiloPassCancellation, scheduleOrganizationKiloPassCancellation } =
      await import('./stripe-adapter');
    const input = {
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
      organizationId: 'org_1',
      agreementId: 'agreement_1',
    };

    retrieve.mockResolvedValueOnce(subscription({ schedule: removalPendingSchedule() }));
    scheduleRelease.mockResolvedValueOnce(schedule({ status: 'released' }));
    await resumeOrganizationKiloPassCancellation(input);
    expect(scheduleRelease).toHaveBeenCalledWith('sched_cancel');
    expect(scheduleUpdate).not.toHaveBeenCalled();

    retrieve.mockResolvedValueOnce(subscription());
    scheduleCreate.mockResolvedValueOnce(schedule({ id: 'sched_second', metadata: {} }));
    await scheduleOrganizationKiloPassCancellation(input);
    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sched_second',
      expect.objectContaining({
        metadata: { origin: 'kilo-pass-org-cancellation', agreementId: 'agreement_1' },
      })
    );

    retrieve.mockResolvedValueOnce(
      subscription({ schedule: removalPendingSchedule({ id: 'sched_second' }) })
    );
    scheduleRelease.mockResolvedValueOnce(schedule({ id: 'sched_second', status: 'released' }));
    await resumeOrganizationKiloPassCancellation(input);
    expect(scheduleRelease).toHaveBeenLastCalledWith('sched_second');
  });

  test('treats an already released schedule as a successful resume', async () => {
    retrieve.mockResolvedValue(subscription({ schedule: removalPendingSchedule() }));
    scheduleRelease.mockRejectedValue(new Error('schedule is not active'));
    scheduleRetrieve.mockResolvedValue(removalPendingSchedule({ status: 'released' }));
    const { resumeOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await expect(
      resumeOrganizationKiloPassCancellation({
        providerSubscriptionId: 'sub_1',
        providerSeatAddOnItemId: 'si_pass',
        organizationId: 'org_1',
      })
    ).resolves.toBeUndefined();
  });

  test('refuses to resume by releasing a schedule it does not own', async () => {
    retrieve.mockResolvedValue(
      subscription({ schedule: removalPendingSchedule({ metadata: { origin: 'support' } }) })
    );
    const { resumeOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await expect(
      resumeOrganizationKiloPassCancellation({
        providerSubscriptionId: 'sub_1',
        providerSeatAddOnItemId: 'si_pass',
        organizationId: 'org_1',
      })
    ).rejects.toThrow('SCHEDULE_REWRITE_UNSAFE');
    expect(scheduleRelease).not.toHaveBeenCalled();
  });

  test.each(['void', 'uncollectible'] as const)(
    'ends pending agreement and removes its add-on when invoice becomes %s',
    async status => {
      select.mockReturnValue({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [dbAgreement({ state: 'pending_payment' })] }),
          }),
        }),
      });
      retrieve.mockResolvedValue(subscription());
      update.mockResolvedValue(subscription());
      const { endPendingOrganizationKiloPassForTerminalInvoice } = await import('./stripe-adapter');

      await expect(
        endPendingOrganizationKiloPassForTerminalInvoice({
          status,
          parent: { subscription_details: { subscription: 'sub_1' } },
          lines: {
            data: [
              {
                parent: { subscription_item_details: { subscription_item: 'si_pass' } },
              },
            ],
          },
        } as unknown as Stripe.Invoice)
      ).resolves.toBe(true);

      expect(update).toHaveBeenCalledWith('sub_1', {
        proration_behavior: 'none',
        items: [{ id: 'si_pass', deleted: true }],
      });
      expect(updateSet).toHaveBeenCalledWith({ state: 'ended' });
    }
  );

  test('ends an unbound pending agreement for a terminal Kilo Pass-priced invoice', async () => {
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [
              dbAgreement({
                state: 'pending_payment',
                provider_seat_add_on_item_id: 'pending:sub_1',
              }),
            ],
          }),
        }),
      }),
    });
    retrieve.mockResolvedValue(subscription());
    update.mockResolvedValue(subscription());
    const { endPendingOrganizationKiloPassForTerminalInvoice } = await import('./stripe-adapter');

    await expect(
      endPendingOrganizationKiloPassForTerminalInvoice({
        status: 'void',
        parent: { subscription_details: { subscription: 'sub_1' } },
        lines: {
          data: [
            {
              pricing: { price_details: { price: 'price_pass', product: 'prod_pass' } },
            },
          ],
        },
      } as unknown as Stripe.Invoice)
    ).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith('sub_1', {
      proration_behavior: 'none',
      items: [{ id: 'si_pass', deleted: true }],
    });
    expect(updateSet).toHaveBeenCalledWith({ state: 'ended' });
  });

  test('ignores a seat-only terminal invoice for an unbound pending agreement', async () => {
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [
              dbAgreement({
                state: 'pending_payment',
                provider_seat_add_on_item_id: 'pending:sub_1',
              }),
            ],
          }),
        }),
      }),
    });
    const { endPendingOrganizationKiloPassForTerminalInvoice } = await import('./stripe-adapter');

    await expect(
      endPendingOrganizationKiloPassForTerminalInvoice({
        status: 'void',
        parent: { subscription_details: { subscription: 'sub_1' } },
        lines: {
          data: [
            {
              pricing: { price_details: { price: 'price_seat', product: 'prod_seat' } },
            },
          ],
        },
      } as unknown as Stripe.Invoice)
    ).resolves.toBe(false);

    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(updateDb).not.toHaveBeenCalled();
  });

  test('ignores a terminal seat-only invoice while the pass invoice is pending', async () => {
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => [dbAgreement({ state: 'pending_payment' })] }),
        }),
      }),
    });
    const { endPendingOrganizationKiloPassForTerminalInvoice } = await import('./stripe-adapter');

    await expect(
      endPendingOrganizationKiloPassForTerminalInvoice({
        status: 'void',
        parent: { subscription_details: { subscription: 'sub_1' } },
        lines: {
          data: [
            {
              parent: { subscription_item_details: { subscription_item: 'si_seat' } },
            },
          ],
        },
      } as unknown as Stripe.Invoice)
    ).resolves.toBe(false);

    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(updateDb).not.toHaveBeenCalled();
  });

  test('keeps a pending agreement pending until its recognized invoice is paid', async () => {
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [dbAgreement({ state: 'pending_payment' })],
          orderBy: () => ({
            limit: async () => [dbAgreement({ state: 'pending_payment' })],
          }),
        }),
      }),
    });
    retrieve.mockResolvedValue(subscription());
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_pass',
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid, handleOrganizationKiloPassSubscriptionEvent } =
      await import('./stripe-adapter');

    await expect(handleOrganizationKiloPassSubscriptionEvent(subscription())).resolves.toBe(true);
    expect(updateDb).not.toHaveBeenCalled();
    expect(activatePaidAgreement).not.toHaveBeenCalled();

    await expect(handleOrganizationKiloPassInvoicePaid({ invoice })).resolves.toBe(true);
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ agreementId: 'agreement_1' })
    );
  });

  test('reverses a scheduled cancellation once the provider has no pending removal', async () => {
    const { handleOrganizationKiloPassSubscriptionEvent } = await import('./stripe-adapter');
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [dbAgreement({ state: 'cancel_at_period_end' })],
          orderBy: () => ({
            limit: async () => [dbAgreement({ state: 'cancel_at_period_end' })],
          }),
        }),
      }),
    });
    retrieve.mockResolvedValue(subscription());

    await expect(handleOrganizationKiloPassSubscriptionEvent(subscription())).resolves.toBe(true);
    expect(updateSet).toHaveBeenCalledWith({
      state: 'active',
      cancellation_effective_at: null,
    });
  });

  test('keeps a scheduled cancellation while the owned removal is still pending', async () => {
    const { handleOrganizationKiloPassSubscriptionEvent } = await import('./stripe-adapter');
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [dbAgreement({ state: 'cancel_at_period_end' })],
          }),
        }),
      }),
    });
    retrieve.mockResolvedValue(subscription({ schedule: removalPendingSchedule() }));

    await expect(handleOrganizationKiloPassSubscriptionEvent(subscription())).resolves.toBe(true);
    expect(retrieve).toHaveBeenCalledWith('sub_1');
    expect(updateDb).not.toHaveBeenCalled();
  });

  test('releases the owned schedule once renewal has removed the pass item', async () => {
    const { handleOrganizationKiloPassSubscriptionEvent } = await import('./stripe-adapter');
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [dbAgreement({ state: 'cancel_at_period_end' })],
          orderBy: () => ({
            limit: async () => [dbAgreement({ state: 'cancel_at_period_end' })],
          }),
        }),
      }),
    });
    retrieve.mockResolvedValue(
      subscription({
        items: { data: [subscription().items.data[0]!] } as Stripe.ApiList<Stripe.SubscriptionItem>,
      })
    );
    const renewedSchedule = removalPendingSchedule({
      current_phase: { start_date: PERIOD_END, end_date: NEXT_PERIOD_END },
    });
    const renewed = subscription({
      schedule: 'sched_cancel',
      items: {
        data: [{ ...subscription().items.data[0]!, current_period_end: NEXT_PERIOD_END }],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    scheduleRetrieve.mockResolvedValue(renewedSchedule);
    scheduleRelease.mockResolvedValue({ ...renewedSchedule, status: 'released' });

    await expect(handleOrganizationKiloPassSubscriptionEvent(renewed)).resolves.toBe(true);
    expect(scheduleRelease).toHaveBeenCalledWith('sched_cancel');
    expect(endAgreementAfterPassItemRemoved).toHaveBeenCalledWith({
      agreementId: 'agreement_1',
      scheduleRelease: { scheduleId: 'sched_cancel', status: 'released', alreadyTerminal: false },
    });

    scheduleRetrieve.mockResolvedValue({ ...renewedSchedule, status: 'released' });
    await expect(handleOrganizationKiloPassSubscriptionEvent(renewed)).resolves.toBe(true);
    expect(scheduleRelease).toHaveBeenCalledTimes(1);
    expect(endAgreementAfterPassItemRemoved).toHaveBeenLastCalledWith({
      agreementId: 'agreement_1',
      scheduleRelease: { scheduleId: 'sched_cancel', status: 'released', alreadyTerminal: true },
    });
  });

  test('keeps the agreement open for webhook retry when the schedule release fails', async () => {
    const { handleOrganizationKiloPassSubscriptionEvent } = await import('./stripe-adapter');
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [dbAgreement({ state: 'cancel_at_period_end' })],
          orderBy: () => ({
            limit: async () => [dbAgreement({ state: 'cancel_at_period_end' })],
          }),
        }),
      }),
    });
    retrieve.mockResolvedValue(
      subscription({
        items: { data: [subscription().items.data[0]!] } as Stripe.ApiList<Stripe.SubscriptionItem>,
      })
    );
    const renewedSchedule = removalPendingSchedule({
      current_phase: { start_date: PERIOD_END, end_date: NEXT_PERIOD_END },
    });
    scheduleRetrieve.mockResolvedValue(renewedSchedule);
    scheduleRelease.mockRejectedValue(new Error('stripe unavailable'));

    await expect(
      handleOrganizationKiloPassSubscriptionEvent(
        subscription({
          schedule: 'sched_cancel',
          items: {
            data: [subscription().items.data[0]!],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        })
      )
    ).rejects.toThrow('stripe unavailable');
    expect(endAgreementAfterPassItemRemoved).not.toHaveBeenCalled();
  });

  test('binds the persisted provider item instead of the first non-seat item', async () => {
    const { resolveOrganizationKiloPassSubscriptionItem, handleOrganizationKiloPassInvoicePaid } =
      await import('./stripe-adapter');
    const mixed = subscription({
      items: {
        data: [
          subscription().items.data[0]!,
          {
            id: 'si_other',
            quantity: 1,
            price: { id: 'price_other', recurring: { interval: 'month' } },
            current_period_start: 1_767_225_600,
            current_period_end: 1_769_904_000,
          },
          subscription().items.data[1]!,
        ],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    expect(
      resolveOrganizationKiloPassSubscriptionItem({
        subscription: mixed,
        boundProviderItemId: 'si_pass',
      })?.id
    ).toBe('si_pass');

    retrieve.mockResolvedValue(mixed);
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_other',
            quantity: 99,
            period: { start: 1, end: 2 },
            parent: { subscription_item_details: { subscription_item: 'si_other' } },
          },
          {
            id: 'line_pass',
            quantity: 2,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
          {
            id: 'line_seat',
            quantity: 5,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_seat' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;

    await expect(handleOrganizationKiloPassInvoicePaid({ invoice })).resolves.toBe(true);
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({
        paidSeatCount: 5,
        paidFrom: new Date('2026-01-04T12:00:00.000Z'),
        paidUntil: new Date('2026-02-01T00:00:00.000Z'),
      })
    );
    expect(createParentSupplement).toHaveBeenCalledWith(
      expect.objectContaining({ providerInvoiceLineId: 'line_pass' })
    );
  });

  test('falls back to the known Kilo Pass price when the provider item is unbound', async () => {
    const { resolveOrganizationKiloPassSubscriptionItem } = await import('./stripe-adapter');
    const unbound = subscription({
      items: {
        data: [
          subscription().items.data[0]!,
          {
            id: 'si_other',
            quantity: 1,
            price: { id: 'price_other', recurring: { interval: 'month' } },
          },
          subscription().items.data[1]!,
        ],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    expect(
      resolveOrganizationKiloPassSubscriptionItem({
        subscription: unbound,
        boundProviderItemId: 'pending:sub_1',
      })?.id
    ).toBe('si_pass');
  });

  test('falls back to item metadata when the Kilo Pass price is unknown', async () => {
    const { resolveOrganizationKiloPassSubscriptionItem } = await import('./stripe-adapter');
    const legacy = subscription({
      items: {
        data: [
          subscription().items.data[0]!,
          {
            id: 'si_legacy',
            quantity: 9,
            price: { id: 'price_legacy_pass', recurring: { interval: 'month' } },
            metadata: {
              type: 'kilo-pass-org',
              organizationId: 'org_1',
              kiloUserId: 'user_1',
              tier: 'tier_19',
              cadence: 'monthly',
            },
          },
        ],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    expect(
      resolveOrganizationKiloPassSubscriptionItem({
        subscription: legacy,
        boundProviderItemId: 'pending:sub_1',
      })?.id
    ).toBe('si_legacy');
  });

  test('ignores a service-fee item when locating the bound Kilo Pass add-on', async () => {
    const {
      resolveOrganizationKiloPassSubscriptionItem,
      handleOrganizationKiloPassSubscriptionEvent,
    } = await import('./stripe-adapter');
    const withFee = subscription({
      items: {
        data: [
          subscription().items.data[0]!,
          {
            id: 'si_fee',
            quantity: 1,
            price: {
              id: 'price_fee',
              recurring: { interval: 'month' },
              metadata: {
                type: SERVICE_FEE_METADATA_TYPE,
                serviceFeeVersion: SERVICE_FEE_VERSION,
              },
            },
            metadata: {
              type: SERVICE_FEE_METADATA_TYPE,
              serviceFeeVersion: SERVICE_FEE_VERSION,
            },
          },
          subscription().items.data[1]!,
        ],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    expect(
      resolveOrganizationKiloPassSubscriptionItem({
        subscription: withFee,
        boundProviderItemId: 'pending:sub_1',
      })?.id
    ).toBe('si_pass');

    await expect(handleOrganizationKiloPassSubscriptionEvent(withFee)).resolves.toBe(true);
    expect(bindProviderSeatAddOnItem).not.toHaveBeenCalled();
  });

  test('does not use a service-fee invoice line for period, quantity, or capacity', async () => {
    retrieve.mockResolvedValue(subscription());
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: {
        data: [
          {
            id: 'line_fee',
            quantity: 99,
            amount: 245,
            period: { start: 10, end: 20 },
            metadata: {
              type: SERVICE_FEE_METADATA_TYPE,
              serviceFeeVersion: SERVICE_FEE_VERSION,
              serviceFeeAssessmentKey: 'invoice:in_1',
              serviceFeeRateBasisPoints: String(SERVICE_FEE_RATE_BASIS_POINTS),
            },
            pricing: { price_details: { price: 'price_pass', product: 'prod_fee' } },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
          {
            id: 'line_pass',
            quantity: 2,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_pass' } },
          },
          {
            id: 'line_seat',
            quantity: 5,
            period: { start: 1_767_528_000, end: 1_769_904_000 },
            parent: { subscription_item_details: { subscription_item: 'si_seat' } },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

    await expect(handleOrganizationKiloPassInvoicePaid({ invoice })).resolves.toBe(true);
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({
        paidSeatCount: 5,
        paidFrom: new Date('2026-01-04T12:00:00.000Z'),
        paidUntil: new Date('2026-02-01T00:00:00.000Z'),
      })
    );
    expect(createParentSupplement).toHaveBeenCalledWith(
      expect.objectContaining({ providerInvoiceLineId: 'line_pass', paidSeatCount: 5 })
    );
  });

  test('checkout still adds the pass when current tax is unapproved', async () => {
    retrieve.mockResolvedValue(
      subscription({ items: { ...subscription().items, data: [subscription().items.data[0]!] } })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    update.mockResolvedValue({
      ...subscription(),
      latest_invoice: {
        id: 'in_draft',
        status: 'draft',
        amount_due: 4_900,
        currency: 'usd',
        created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        customer: 'cus_1',
        confirmation_secret: { type: 'payment_intent', client_secret: 'pi_secret_1' },
        parent: { subscription_details: { subscription: 'sub_1' } },
        lines: {
          data: [
            {
              id: 'line_pass',
              amount: 4_900,
              currency: 'usd',
              period: { start: 1_767_528_000, end: 1_769_904_000 },
              pricing: { price_details: { price: 'price_pass', product: 'prod_pass' } },
              parent: { subscription_item_details: { subscription_item: 'si_pass' } },
            },
          ],
          has_more: false,
        },
      } as unknown as Stripe.Invoice,
    });
    invoicePaymentsList.mockResolvedValue({
      object: 'list',
      data: [
        {
          status: 'open',
          payment: {
            type: 'payment_intent',
            payment_intent: { status: 'requires_action' },
          },
        } as unknown as Stripe.InvoicePayment,
      ],
      has_more: false,
      url: '/v1/invoice_payments',
    });
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
        serviceFee: {
          store: createMemoryAssessmentStore(),
        },
      })
    ).resolves.toEqual({ kind: 'payment_action', clientSecret: 'pi_secret_1' });
    expect(update).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({
        items: [{ price: 'price_pass', quantity: 9 }],
      })
    );
    expect(bindProviderSeatAddOnItem).toHaveBeenCalledWith({
      agreementId: 'agreement_1',
      providerSeatAddOnItemId: 'si_pass',
    });
    expect(invoiceItemCreate).not.toHaveBeenCalled();
  });

  test('initial add-on attaches one non-discountable fee on net Kilo Pass only', async () => {
    retrieve.mockResolvedValue(
      subscription({
        customer: 'cus_1',
        items: { ...subscription().items, data: [subscription().items.data[0]!] },
      })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    const draftInvoice = mixedDraftInvoice({
      id: 'in_add_on',
      lines: [seatInvoiceLine(72_000), passInvoiceLine(4_900, { id: 'line_pass' })],
    });
    createPreview.mockResolvedValue({
      id: 'in_preview_add_on',
      currency: 'usd',
      customer: 'cus_1',
      created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      status: 'draft',
      lines: draftInvoice.lines,
    });
    update.mockResolvedValue({
      ...subscription({ customer: 'cus_1' }),
      latest_invoice: {
        ...draftInvoice,
        confirmation_secret: { type: 'payment_intent', client_secret: 'pi_secret_1' },
      } as unknown as Stripe.Invoice,
    });
    invoicePaymentsList.mockResolvedValue({
      object: 'list',
      data: [
        {
          status: 'open',
          payment: {
            type: 'payment_intent',
            payment_intent: { status: 'requires_action' },
          },
        } as unknown as Stripe.InvoicePayment,
      ],
      has_more: false,
      url: '/v1/invoice_payments',
    });
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
        serviceFee: {
          store: createMemoryAssessmentStore(),
          stripe: {
            invoices: { listLineItems, createPreview },
            invoiceItems: { create: invoiceItemCreate },
            subscriptions: { retrieve },
          } as OrganizationKiloPassSeatCapacityStripe,
          deps: {
            now: new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000),
            getOrganizationPurchaseChannel: async () => 'self_serve',
            resolveTaxInput: async () => ({
              source: 'price',
              taxBehavior: 'exclusive',
            }),
          },
        },
      })
    ).resolves.toEqual({ kind: 'payment_action', clientSecret: 'pi_secret_1' });
    expect(invoiceItemCreate).toHaveBeenCalled();
    expect(invoiceItemCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        amount: 245,
        discountable: false,
        description: SERVICE_FEE_DESCRIPTION,
        tax_behavior: 'exclusive',
        metadata: expect.objectContaining({
          type: SERVICE_FEE_METADATA_TYPE,
          serviceFeeVersion: SERVICE_FEE_VERSION,
          serviceFeeAssessmentKey: expect.stringMatching(/^org-checkout:/),
          serviceFeeRateBasisPoints: String(SERVICE_FEE_RATE_BASIS_POINTS),
        }),
      })
    );
    expect(invoiceItemCreate.mock.calls[0]?.[0].invoice).toBeUndefined();
    expect(update).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          type: 'kilo-pass-org',
          organizationId: 'org_1',
          kiloUserId: 'user_1',
        }),
      })
    );
    expect(update.mock.calls[0]?.[1].metadata).not.toHaveProperty('serviceFeeAssessmentKey');
    expect(update.mock.calls[0]?.[1].metadata).not.toHaveProperty('serviceFeeFlow');
  });

  test('stages the fee before update so a paid invoice can still charge', async () => {
    retrieve.mockResolvedValue(
      subscription({
        customer: 'cus_1',
        items: { ...subscription().items, data: [subscription().items.data[0]!] },
      })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    const previewLines = [seatInvoiceLine(72_000), passInvoiceLine(4_900, { id: 'line_pass' })];
    createPreview.mockResolvedValue({
      id: 'in_preview_paid',
      currency: 'usd',
      customer: 'cus_1',
      created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      status: 'draft',
      lines: { object: 'list', data: previewLines, has_more: false, url: '/v1/invoices' },
    });
    const store = createMemoryAssessmentStore();
    update.mockImplementation(async () => {
      const assessmentKey = createdInvoiceItemAssessmentKey() ?? 'org-checkout:x';
      return {
        ...subscription({ customer: 'cus_1' }),
        latest_invoice: mixedDraftInvoice({
          id: 'in_paid_add_on',
          status: 'paid',
          amount_due: 0,
          lines: [
            ...previewLines,
            passInvoiceLine(245, {
              id: 'il_fee',
              description: SERVICE_FEE_DESCRIPTION,
              discountable: false,
              metadata: {
                type: SERVICE_FEE_METADATA_TYPE,
                serviceFeeAssessmentKey: assessmentKey,
                serviceFeeVersion: SERVICE_FEE_VERSION,
                serviceFeeRateBasisPoints: String(SERVICE_FEE_RATE_BASIS_POINTS),
              },
            }),
          ],
        }),
      };
    });
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await expect(
      createOrganizationKiloPassCheckout({
        organizationId: 'org_1',
        actorUserId: 'user_1',
        tier: 'tier_19',
        allocations: [],
        serviceFee: {
          store,
          stripe: {
            invoices: { listLineItems, createPreview },
            invoiceItems: { create: invoiceItemCreate, del: invoiceItemDel },
            subscriptions: { retrieve },
          } as OrganizationKiloPassSeatCapacityStripe,
          deps: {
            now: new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000),
            getOrganizationPurchaseChannel: async () => 'self_serve',
            resolveTaxInput: async () => ({
              source: 'price',
              taxBehavior: 'exclusive',
            }),
          },
        },
      })
    ).resolves.toEqual({ kind: 'completed' });
    expect(invoiceItemCreate).toHaveBeenCalledTimes(1);
    expect(invoiceItemCreate.mock.calls[0]?.[0].invoice).toBeUndefined();
    expect(invoiceItemDel).toHaveBeenCalledWith('ii_fee');
    const assessmentKey = createdInvoiceItemAssessmentKey();
    expect(assessmentKey).toEqual(expect.stringMatching(/^org-checkout:/));
    expect(await store.findByAssessmentKey(assessmentKey ?? '')).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 245,
    });
  });

  test('overlapping webhook does not create a second fee item when checkout already attached', async () => {
    retrieve.mockResolvedValue(
      subscription({
        customer: 'cus_1',
        items: { ...subscription().items, data: [subscription().items.data[0]!] },
      })
    );
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1', created: true });
    const draftInvoice = mixedDraftInvoice({
      id: 'in_overlap',
      lines: [seatInvoiceLine(72_000), passInvoiceLine(4_900, { id: 'line_pass_overlap' })],
    });
    createPreview.mockResolvedValue({
      id: 'in_preview_overlap',
      currency: 'usd',
      customer: 'cus_1',
      created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
      status: 'draft',
      lines: draftInvoice.lines,
    });
    update.mockResolvedValue({
      ...subscription({ customer: 'cus_1' }),
      latest_invoice: {
        ...draftInvoice,
        confirmation_secret: { type: 'payment_intent', client_secret: 'pi_secret_overlap' },
      } as unknown as Stripe.Invoice,
    });
    invoicePaymentsList.mockResolvedValue({
      object: 'list',
      data: [
        {
          status: 'open',
          payment: {
            type: 'payment_intent',
            payment_intent: { status: 'requires_action' },
          },
        } as unknown as Stripe.InvoicePayment,
      ],
      has_more: false,
      url: '/v1/invoice_payments',
    });
    const store = createMemoryAssessmentStore();
    const { createOrganizationKiloPassCheckout } = await import('./stripe-adapter');

    await createOrganizationKiloPassCheckout({
      organizationId: 'org_1',
      actorUserId: 'user_1',
      tier: 'tier_19',
      allocations: [],
      serviceFee: {
        store,
        stripe: {
          invoices: { listLineItems, createPreview },
          invoiceItems: { create: invoiceItemCreate },
          subscriptions: { retrieve },
        } as OrganizationKiloPassSeatCapacityStripe,
        deps: {
          now: new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000),
          resolveTaxInput: async () => ({
            source: 'price',
            taxBehavior: 'exclusive',
          }),
          getOrganizationPurchaseChannel: async () => 'self_serve',
        },
      },
    });
    const createsAfterCheckout = invoiceItemCreate.mock.calls.length;
    expect(createsAfterCheckout).toBeGreaterThanOrEqual(1);
    const assessmentKey = createdInvoiceItemAssessmentKey();
    expect(assessmentKey).toEqual(expect.stringMatching(/^org-checkout:/));

    const { handleKiloPassInvoiceCreated } = await import('@/lib/service-fees/invoice-created');
    await handleKiloPassInvoiceCreated({
      invoice: {
        ...draftInvoice,
        lines: {
          ...draftInvoice.lines,
          data: [
            ...draftInvoice.lines.data,
            {
              ...passInvoiceLine(245, { id: 'il_overlap_fee' }),
              discountable: false,
              metadata: buildServiceFeeLineMetadata(String(assessmentKey)),
            } as Stripe.InvoiceLineItem,
          ],
        },
        parent: {
          type: 'subscription_details',
          quote_details: null,
          subscription_details: {
            metadata: {
              type: 'kilo-pass-org',
              organizationId: 'org_1',
              kiloUserId: 'user_1',
            },
            subscription: 'sub_1',
          },
        },
      } as Stripe.Invoice,
      stripe: {
        invoices: { listLineItems },
        invoiceItems: { create: invoiceItemCreate },
        subscriptions: { retrieve },
      },
      store,
      deps: {
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => ({
          source: 'price',
          taxBehavior: 'exclusive',
        }),
      },
    });
    expect(invoiceItemCreate).toHaveBeenCalledTimes(createsAfterCheckout);
    expect(await store.findByAssessmentKey(String(assessmentKey))).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 245,
    });
  });
});

const SEAT_PRODUCT_ID = [...SEAT_PRODUCT_IDS][0] ?? 'prod_seat';
const SEAT_PRICE_ID = process.env.STRIPE_TEAMS_MONTHLY_PRICE_ID ?? 'price_seat';

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
  return Object.assign(store, {
    async findByStripeInvoiceId(stripeInvoiceId: string) {
      const row = [...rows.values()].find(
        candidate => candidate.stripeInvoiceId === stripeInvoiceId
      );
      return row ? { ...row, metadata: { ...row.metadata } } : null;
    },
  });
}

function passInvoiceLine(
  amount: number,
  extra: Partial<Stripe.InvoiceLineItem> = {}
): Stripe.InvoiceLineItem {
  return {
    id: extra.id ?? 'il_pass',
    object: 'line_item',
    amount,
    currency: 'usd',
    description: 'Kilo Pass',
    discountable: true,
    discount_amounts: null,
    discounts: [],
    invoice: 'in_test',
    livemode: false,
    metadata: extra.metadata ?? {
      type: 'kilo-pass-org',
      organizationId: 'org_1',
      kiloUserId: 'user_1',
      tier: 'tier_19',
      cadence: 'monthly',
    },
    parent: extra.parent ?? {
      type: 'subscription_item_details',
      invoice_item_details: null,
      subscription_item_details: {
        invoice_item: null,
        proration: false,
        proration_details: { credited_items: null },
        subscription: 'sub_1',
        subscription_item: 'si_pass',
      },
    },
    period: extra.period ?? { start: 1, end: 2 },
    pretax_credit_amounts: null,
    pricing: {
      type: 'price_details',
      unit_amount_decimal: String(amount),
      price_details: { price: 'price_pass', product: 'prod_pass' },
    },
    quantity: extra.quantity ?? 1,
    subscription: 'sub_1',
    taxes: null,
    ...extra,
  } as Stripe.InvoiceLineItem;
}

function seatInvoiceLine(amount: number): Stripe.InvoiceLineItem {
  return {
    id: 'il_seat',
    object: 'line_item',
    amount,
    currency: 'usd',
    description: 'Seats',
    discountable: true,
    discount_amounts: null,
    discounts: [],
    invoice: 'in_test',
    livemode: false,
    metadata: {},
    parent: {
      type: 'subscription_item_details',
      invoice_item_details: null,
      subscription_item_details: {
        invoice_item: null,
        proration: false,
        proration_details: { credited_items: null },
        subscription: 'sub_1',
        subscription_item: 'si_seat',
      },
    },
    period: { start: 1, end: 2 },
    pretax_credit_amounts: null,
    pricing: {
      type: 'price_details',
      unit_amount_decimal: String(amount),
      price_details: { price: SEAT_PRICE_ID, product: SEAT_PRODUCT_ID },
    },
    quantity: 9,
    subscription: 'sub_1',
    taxes: null,
  } as Stripe.InvoiceLineItem;
}

function mixedDraftInvoice(
  overrides: {
    id?: string;
    lines?: Stripe.InvoiceLineItem[];
    metadata?: Stripe.Metadata;
    status?: Stripe.Invoice.Status;
    amount_due?: number;
  } = {}
): Stripe.Invoice {
  const lines = overrides.lines ?? [seatInvoiceLine(72_000), passInvoiceLine(4_900)];
  const metadata = overrides.metadata ?? {
    type: 'kilo-pass-org',
    organizationId: 'org_1',
    kiloUserId: 'user_1',
    tier: 'tier_19',
    cadence: 'monthly',
  };
  return {
    id: overrides.id ?? 'in_test',
    object: 'invoice',
    created: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
    status: overrides.status ?? 'draft',
    currency: 'usd',
    customer: 'cus_1',
    amount_due: overrides.amount_due ?? lines.reduce((sum, line) => sum + (line.amount ?? 0), 0),
    amount_paid: 0,
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: {
        metadata,
        subscription: 'sub_1',
      },
    },
    metadata,
    lines: {
      object: 'list',
      data: lines,
      has_more: false,
      url: '/v1/invoices/in_test/lines',
    },
  } as Stripe.Invoice;
}

describe('organization Kilo Pass service-fee attachment', () => {
  test('mixed seats and pass charge one fee on the net Kilo Pass product only', async () => {
    const { attachOrganizationKiloPassServiceFeeToDraftInvoice } = await import('./stripe-adapter');
    const create = jest.fn(async (params: Stripe.InvoiceItemCreateParams) => {
      expect(params.amount).toBe(245);
      expect(params.discountable).toBe(false);
      return { id: 'ii_fee', amount: 245 };
    });
    const result = await attachOrganizationKiloPassServiceFeeToDraftInvoice({
      invoice: mixedDraftInvoice(),
      subscription: subscription(),
      store: createMemoryAssessmentStore(),
      stripe: {
        invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
        invoiceItems: { create },
        subscriptions: { retrieve },
      },
      deps: {
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      },
    });
    expect(result.assessment).toMatchObject({
      flow: 'organization_kilo_pass',
      eligibleSubtotalMinor: 4_900,
      chargedFeeMinor: 245,
      organizationId: 'org_1',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('capacity-increase proration attaches one fee on the positive Kilo Pass net', async () => {
    const { attachOrganizationKiloPassServiceFeeToDraftInvoice } = await import('./stripe-adapter');
    const create = jest.fn(async (params: Stripe.InvoiceItemCreateParams) => {
      expect(params.amount).toBe(150);
      expect(params.discountable).toBe(false);
      return { id: 'ii_fee', amount: 150 };
    });
    const result = await attachOrganizationKiloPassServiceFeeToDraftInvoice({
      invoice: mixedDraftInvoice({
        id: 'in_increase',
        lines: [seatInvoiceLine(8_000), passInvoiceLine(3_000, { id: 'il_pass_proration' })],
      }),
      subscription: subscription(),
      store: createMemoryAssessmentStore(),
      stripe: {
        invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
        invoiceItems: { create },
        subscriptions: { retrieve },
      },
      deps: {
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => ({
          source: 'price',
          taxBehavior: 'exclusive',
        }),
      },
    });
    expect(result.assessment).toMatchObject({
      eligibleSubtotalMinor: 3_000,
      chargedFeeMinor: 150,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('zero and negative net Kilo Pass omit the fee line', async () => {
    const { attachOrganizationKiloPassServiceFeeToDraftInvoice } = await import('./stripe-adapter');
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 1 }));
    const stripeClient = {
      invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
      invoiceItems: { create },
      subscriptions: { retrieve },
    };
    const deps = {
      getOrganizationPurchaseChannel: async () => 'self_serve' as const,
      resolveTaxInput: async () => ({
        source: 'inline_inherit' as const,
      }),
    };

    const zero = await attachOrganizationKiloPassServiceFeeToDraftInvoice({
      invoice: mixedDraftInvoice({
        id: 'in_zero',
        lines: [seatInvoiceLine(72_000), passInvoiceLine(0, { id: 'il_zero' })],
      }),
      store: createMemoryAssessmentStore(),
      stripe: stripeClient,
      deps,
    });
    const negative = await attachOrganizationKiloPassServiceFeeToDraftInvoice({
      invoice: mixedDraftInvoice({
        id: 'in_negative',
        lines: [
          seatInvoiceLine(72_000),
          passInvoiceLine(2_000, { id: 'il_pos' }),
          passInvoiceLine(-5_000, { id: 'il_credit' }),
        ],
      }),
      store: createMemoryAssessmentStore(),
      stripe: stripeClient,
      deps,
    });

    expect(zero.assessment).toMatchObject({
      outcome: 'zero_rounded',
      expectedFeeMinor: 0,
      chargedFeeMinor: 0,
    });
    expect(negative.assessment).toMatchObject({
      outcome: 'zero_rounded',
      eligibleSubtotalMinor: 0,
      chargedFeeMinor: 0,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test('exact organization exemption omits the fee and does not inherit', async () => {
    const { attachOrganizationKiloPassServiceFeeToDraftInvoice } = await import('./stripe-adapter');
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const findEffectiveExemption: NonNullable<
      KiloPassInvoiceCreatedDependencies['findEffectiveExemption']
    > = jest.fn(async organizationId => {
      expect(organizationId).toBe('org_1');
      return { id: 'hist_exempt', isExempt: true };
    });
    const result = await attachOrganizationKiloPassServiceFeeToDraftInvoice({
      invoice: mixedDraftInvoice(),
      store: createMemoryAssessmentStore(),
      stripe: {
        invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
        invoiceItems: { create },
        subscriptions: { retrieve },
      },
      deps: {
        getOrganizationPurchaseChannel: async () => 'self_serve',
        findEffectiveExemption,
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      },
    });
    expect(findEffectiveExemption).toHaveBeenCalledWith(
      'org_1',
      new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000)
    );
    expect(result.assessment).toMatchObject({
      outcome: 'exempt',
      exemptionId: 'hist_exempt',
      chargedFeeMinor: 0,
      expectedFeeMinor: 245,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test('manual agreements stay fee-free', async () => {
    const { attachOrganizationKiloPassServiceFeeToDraftInvoice } = await import('./stripe-adapter');
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const result = await attachOrganizationKiloPassServiceFeeToDraftInvoice({
      invoice: mixedDraftInvoice({ id: 'in_manual' }),
      store: createMemoryAssessmentStore(),
      stripe: {
        invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
        invoiceItems: { create },
        subscriptions: { retrieve },
      },
      deps: {
        getOrganizationPurchaseChannel: async () => 'manual',
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      },
    });
    expect(result.assessment).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test('tax resolution failure fails open as missed and does not attach a fee', async () => {
    const { attachOrganizationKiloPassServiceFeeToDraftInvoice } = await import('./stripe-adapter');
    const sendAlert: NonNullable<KiloPassInvoiceCreatedDependencies['sendAlert']> = jest.fn(
      async () => undefined
    );
    const create = jest.fn(async () => ({ id: 'ii_fee', amount: 245 }));
    const result = await attachOrganizationKiloPassServiceFeeToDraftInvoice({
      invoice: mixedDraftInvoice({ id: 'in_tax' }),
      store: createMemoryAssessmentStore(),
      stripe: {
        invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
        invoiceItems: { create },
        subscriptions: { retrieve },
      },
      deps: {
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => {
          throw new Error(SERVICE_FEE_FAILURE_APPLICATION);
        },
        sendAlert,
      },
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

  test('injected tax creates one positive non-discountable fee line', async () => {
    const { attachOrganizationKiloPassServiceFeeToDraftInvoice } = await import('./stripe-adapter');
    const create = jest.fn(async (params: Stripe.InvoiceItemCreateParams) => {
      expect(params).toMatchObject({
        customer: 'cus_1',
        invoice: 'in_test',
        amount: 245,
        currency: 'usd',
        description: SERVICE_FEE_DESCRIPTION,
        discountable: false,
        tax_behavior: 'exclusive',
      });
      return { id: 'ii_fee', amount: 245 };
    });
    const result = await attachOrganizationKiloPassServiceFeeToDraftInvoice({
      invoice: mixedDraftInvoice(),
      store: createMemoryAssessmentStore(),
      stripe: {
        invoices: { listLineItems: async () => ({ data: [], has_more: false }) },
        invoiceItems: { create },
        subscriptions: { retrieve },
      },
      deps: {
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => ({
          source: 'price',
          taxBehavior: 'exclusive',
        }),
      },
    });
    expect(result.status).toBe('charged');
    expect(result.assessment?.chargedFeeMinor).toBe(245);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('organization Kilo Pass seat-capacity fee preparation', () => {
  const prorationDate = SERVICE_FEE_ACTIVATION_UNIX_SECONDS;
  const now = new Date(prorationDate * 1000);

  beforeEach(() => {
    createPreview.mockReset();
    invoiceItemCreate.mockReset();
  });

  function previewInvoice(lines: Stripe.InvoiceLineItem[]): Stripe.Invoice {
    return {
      id: 'in_preview',
      object: 'invoice',
      created: prorationDate,
      status: 'draft',
      currency: 'usd',
      customer: 'cus_1',
      lines: {
        object: 'list',
        data: lines,
        has_more: false,
        url: '/v1/invoices/upcoming/lines',
      },
    } as Stripe.Invoice;
  }

  function seatCapacityStripe(options: {
    previewLines: Stripe.InvoiceLineItem[];
    create?: typeof invoiceItemCreate;
  }) {
    createPreview.mockResolvedValue(previewInvoice(options.previewLines));
    return {
      invoices: {
        createPreview,
        listLineItems: async () => ({ data: [], has_more: false as const }),
      },
      invoiceItems: { create: options.create ?? invoiceItemCreate },
    };
  }

  test('previews seat+pass quantities and charges only the Kilo Pass net', async () => {
    const {
      prepareOrganizationKiloPassSeatCapacityFee,
      createSeatCapacityServiceFeeAssessmentKey,
    } = await import('./stripe-adapter');
    const create = jest.fn(async (params: Stripe.InvoiceItemCreateParams) => {
      expect(params.amount).toBe(150);
      expect(params.invoice).toBeUndefined();
      return { id: 'ii_fee', amount: 150 };
    });
    const prepared = await prepareOrganizationKiloPassSeatCapacityFee({
      subscription: subscription({ customer: 'cus_1' }),
      paidSeatItemId: 'si_seat',
      paidSeatQuantity: 10,
      isIncreasingSeats: true,
      prorationDate,
      store: createMemoryAssessmentStore(),
      stripe: seatCapacityStripe({
        previewLines: [seatInvoiceLine(8_000), passInvoiceLine(3_000, { id: 'il_pass_proration' })],
        create,
      }),
      deps: {
        now,
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => ({
          source: 'price',
          taxBehavior: 'exclusive',
        }),
      },
    });

    expect(createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: 'sub_1',
        subscription_details: expect.objectContaining({
          proration_date: prorationDate,
          proration_behavior: 'always_invoice',
          items: [
            { id: 'si_seat', quantity: 10 },
            { id: 'si_pass', quantity: 10 },
          ],
        }),
      })
    );
    expect(prepared.shouldAttach).toBe(true);
    expect(prepared.assessment).toMatchObject({
      assessmentKey: createSeatCapacityServiceFeeAssessmentKey({
        subscriptionId: 'sub_1',
        prorationDate,
        paidSeatQuantity: 10,
      }),
      eligibleSubtotalMinor: 3_000,
      expectedFeeMinor: 150,
      outcome: 'pending',
    });
    expect(prepared.feeInvoiceItem).toMatchObject({
      amount: 150,
      discountable: false,
      tax_behavior: 'exclusive',
    });
    expect(prepared.feeInvoiceItem).not.toHaveProperty('invoice');
    expect(create).not.toHaveBeenCalled();
  });

  test('reuses a pending staged item for the same assessment', async () => {
    const {
      prepareOrganizationKiloPassSeatCapacityFee,
      stagePreparedOrganizationKiloPassServiceFeeItem,
    } = await import('./stripe-adapter');
    const pendingItems: Stripe.InvoiceItem[] = [];
    const create = jest.fn(async (params: Stripe.InvoiceItemCreateParams) => {
      const item = {
        id: 'ii_pending_fee',
        amount: params.amount ?? 0,
        metadata: params.metadata ?? {},
      } as Stripe.InvoiceItem;
      pendingItems.push(item);
      return item;
    });
    const list = jest.fn(async () => ({ data: pendingItems, has_more: false }));
    const stripeClient = {
      ...seatCapacityStripe({
        previewLines: [seatInvoiceLine(8_000), passInvoiceLine(3_000)],
        create,
      }),
      invoiceItems: { create, list },
    };
    const prepared = await prepareOrganizationKiloPassSeatCapacityFee({
      subscription: subscription({ customer: 'cus_1' }),
      paidSeatItemId: 'si_seat',
      paidSeatQuantity: 10,
      isIncreasingSeats: true,
      prorationDate,
      store: createMemoryAssessmentStore(),
      stripe: stripeClient,
      deps: {
        now,
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      },
    });

    await expect(
      stagePreparedOrganizationKiloPassServiceFeeItem({ prepared, stripe: stripeClient })
    ).resolves.toBe('ii_pending_fee');
    await expect(
      stagePreparedOrganizationKiloPassServiceFeeItem({ prepared, stripe: stripeClient })
    ).resolves.toBe('ii_pending_fee');
    expect(create).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  test('seat-only subscriptions skip preview and assessment', async () => {
    const { prepareOrganizationKiloPassSeatCapacityFee } = await import('./stripe-adapter');
    const store = createMemoryAssessmentStore();
    const insert = jest.spyOn(store, 'insert');
    const prepared = await prepareOrganizationKiloPassSeatCapacityFee({
      subscription: subscription({
        metadata: { type: 'seats', organizationId: 'org_1' },
        items: {
          object: 'list',
          data: [
            {
              id: 'si_seat',
              quantity: 5,
              price: { id: 'price_seat', recurring: { interval: 'month' } },
              current_period_start: 1_767_225_600,
              current_period_end: 1_769_904_000,
            },
          ],
          has_more: false,
          url: '/v1/subscription_items',
        },
      } as unknown as Partial<Stripe.Subscription>),
      paidSeatItemId: 'si_seat',
      paidSeatQuantity: 10,
      isIncreasingSeats: true,
      prorationDate,
      store,
      stripe: seatCapacityStripe({ previewLines: [seatInvoiceLine(8_000)] }),
      deps: {
        now,
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => ({ source: 'inline_inherit' }),
      },
    });
    expect(prepared.shouldAttach).toBe(false);
    expect(prepared.assessment).toBeNull();
    expect(createPreview).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  test('manual agreements skip preview and assessment', async () => {
    const { prepareOrganizationKiloPassSeatCapacityFee } = await import('./stripe-adapter');
    const store = createMemoryAssessmentStore();
    const insert = jest.spyOn(store, 'insert');
    const prepared = await prepareOrganizationKiloPassSeatCapacityFee({
      subscription: subscription({ customer: 'cus_1' }),
      paidSeatItemId: 'si_seat',
      paidSeatQuantity: 10,
      isIncreasingSeats: true,
      prorationDate,
      store,
      stripe: seatCapacityStripe({
        previewLines: [seatInvoiceLine(8_000), passInvoiceLine(3_000)],
      }),
      deps: {
        now,
        getOrganizationPurchaseChannel: async () => 'manual',
      },
    });
    expect(prepared.shouldAttach).toBe(false);
    expect(prepared.assessment).toBeNull();
    expect(createPreview).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  test('tax resolution failure persists missed and does not prepare an item', async () => {
    const { prepareOrganizationKiloPassSeatCapacityFee } = await import('./stripe-adapter');
    const sendAlert = jest.fn(async (_input: { failureCode: string }) => undefined);
    const prepared = await prepareOrganizationKiloPassSeatCapacityFee({
      subscription: subscription({ customer: 'cus_1' }),
      paidSeatItemId: 'si_seat',
      paidSeatQuantity: 10,
      isIncreasingSeats: true,
      prorationDate,
      store: createMemoryAssessmentStore(),
      stripe: seatCapacityStripe({
        previewLines: [seatInvoiceLine(8_000), passInvoiceLine(3_000)],
      }),
      deps: {
        now,
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => {
          throw new Error(SERVICE_FEE_FAILURE_APPLICATION);
        },
        sendAlert,
      },
    });
    expect(prepared.shouldAttach).toBe(false);
    expect(prepared.feeInvoiceItem).toBeNull();
    expect(prepared.assessment).toMatchObject({
      outcome: 'missed',
      failureCode: SERVICE_FEE_FAILURE_APPLICATION,
      eligibleSubtotalMinor: 3_000,
      expectedFeeMinor: 150,
    });
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: SERVICE_FEE_FAILURE_APPLICATION })
    );
  });

  test('attach uses the prepared item on the draft invoice and marks charged', async () => {
    const {
      prepareOrganizationKiloPassSeatCapacityFee,
      attachPreparedOrganizationKiloPassServiceFee,
    } = await import('./stripe-adapter');
    const store = createMemoryAssessmentStore();
    const create = jest.fn(async (params: Stripe.InvoiceItemCreateParams) => {
      expect(params).toMatchObject({
        invoice: 'in_actual',
        amount: 150,
        discountable: false,
      });
      return { id: 'ii_fee', amount: 150 };
    });
    const prepared = await prepareOrganizationKiloPassSeatCapacityFee({
      subscription: subscription({ customer: 'cus_1' }),
      paidSeatItemId: 'si_seat',
      paidSeatQuantity: 10,
      isIncreasingSeats: true,
      prorationDate,
      store,
      stripe: seatCapacityStripe({
        previewLines: [seatInvoiceLine(8_000), passInvoiceLine(3_000)],
        create,
      }),
      deps: {
        now,
        getOrganizationPurchaseChannel: async () => 'self_serve',
        resolveTaxInput: async () => ({
          source: 'price',
          taxBehavior: 'exclusive',
        }),
      },
    });
    const charged = await attachPreparedOrganizationKiloPassServiceFee({
      prepared,
      invoice: mixedDraftInvoice({
        id: 'in_actual',
        lines: [seatInvoiceLine(8_000), passInvoiceLine(3_000)],
      }),
      store,
      stripe: { invoiceItems: { create } },
      deps: { now },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(charged).toMatchObject({
      outcome: 'charged',
      chargedFeeMinor: 150,
      stripeInvoiceId: 'in_actual',
      stripeInvoiceFeeItemId: 'ii_fee',
      stripeInvoiceFeeLineItemId: null,
    });
  });
});

describe('organization Kilo Pass invoice.paid settlement', () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    jest.resetAllMocks();
    const rows = [dbAgreement({ parent_organization_id: organizationId })];
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => rows,
          orderBy: () => ({ limit: async () => rows }),
        }),
      }),
    });
    listLineItems.mockResolvedValue({ data: [], has_more: false });
  });

  async function persistOrgAssessment(input: {
    store: ServiceFeeAssessmentStore;
    invoiceId: string;
    outcome: 'charged' | 'exempt' | 'missed';
  }) {
    const assessmentKey = createInvoiceServiceFeeAssessmentKey(input.invoiceId);
    const decision = await prepareServiceFeeAssessmentDecision(
      {
        assessmentKey,
        flow: 'organization_kilo_pass',
        currency: 'usd',
        eligibilityCreatedAt: new Date(SERVICE_FEE_ACTIVATION_UNIX_SECONDS * 1000),
        eligibleSubtotalMinor: 4_900,
        kiloUserId: 'user_1',
        organizationId,
        stripeCustomerId: 'cus_1',
      },
      {
        findEffectiveExemption:
          input.outcome === 'exempt'
            ? async () => ({ id: 'hist_exempt', isExempt: true })
            : async () => null,
      }
    );
    const record = await upsertServiceFeeAssessment({
      store: input.store,
      decision,
      stripeIds: {
        stripeCustomerId: 'cus_1',
        stripeInvoiceId: input.invoiceId,
        stripeInvoiceFeeLineItemId:
          input.outcome === 'charged' ? `il_fee_${input.invoiceId}` : null,
      },
    });
    if (input.outcome === 'charged') {
      return markServiceFeeAssessmentCharged({
        store: input.store,
        assessmentKey: record.assessmentKey,
        chargedFeeMinor: 245,
        stripeIds: { stripeInvoiceFeeLineItemId: `il_fee_${input.invoiceId}` },
      });
    }
    if (input.outcome === 'missed' && decision.outcome === 'pending') {
      return markServiceFeeAssessmentMissed({
        store: input.store,
        assessmentKey: record.assessmentKey,
        failureCode: 'fee_application_failed',
      });
    }
    return record;
  }

  function paidOrgInvoice(input: {
    invoiceId: string;
    assessmentKey: string;
    includeFeeLine?: boolean;
  }): Stripe.Invoice {
    const lines = [
      passInvoiceLine(4_900, {
        id: 'line_pass_settle',
        period: { start: 1_767_528_000, end: 1_769_904_000 },
        quantity: 2,
      }),
      seatInvoiceLine(72_000),
    ];
    if (input.includeFeeLine !== false) {
      lines.unshift({
        ...passInvoiceLine(245, { id: `il_fee_${input.invoiceId}` }),
        metadata: buildServiceFeeLineMetadata(input.assessmentKey),
        pricing: null,
      } as Stripe.InvoiceLineItem);
    }
    return {
      ...mixedDraftInvoice({ id: input.invoiceId, lines }),
      status: 'paid',
      amount_paid: input.includeFeeLine === false ? 4_900 : 5_145,
      status_transitions: {
        finalized_at: SERVICE_FEE_ACTIVATION_UNIX_SECONDS,
        marked_uncollectible_at: null,
        paid_at: SERVICE_FEE_ACTIVATION_UNIX_SECONDS + 10,
        voided_at: null,
      },
      parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: {
          metadata: {
            type: 'kilo-pass-org',
            organizationId,
            kiloUserId: 'user_1',
            serviceFeeAssessmentKey: input.assessmentKey,
          },
          subscription: 'sub_1',
        },
      },
    } as Stripe.Invoice;
  }

  test.each(['charged', 'exempt', 'missed'] as const)(
    'settles a %s assessment before activating the agreement',
    async outcome => {
      retrieve.mockResolvedValue(subscription());
      const store = createMemoryAssessmentStore();
      const invoiceId = `in_org_${outcome}`;
      const record = await persistOrgAssessment({ store, invoiceId, outcome });
      const invoice = paidOrgInvoice({
        invoiceId,
        assessmentKey: record.assessmentKey,
        includeFeeLine: outcome === 'charged',
      });
      activatePaidAgreement.mockImplementation(async () => {
        expect(await store.findByAssessmentKey(record.assessmentKey)).toMatchObject({
          settledAt: expect.any(String),
          outcome,
          settledProductMinor: 4_900,
        });
      });
      const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');

      await expect(
        handleOrganizationKiloPassInvoicePaid({
          invoice,
          serviceFee: {
            store,
            stripe: { invoices: { listLineItems } } as KiloPassServiceFeeSettlementStripe,
          },
        })
      ).resolves.toBe(true);
      expect(activatePaidAgreement).toHaveBeenCalled();
      expect(await store.findByAssessmentKey(record.assessmentKey)).toMatchObject({
        settledAt: expect.any(String),
        outcome,
      });
    }
  );

  test('settlement before activation is idempotent', async () => {
    retrieve.mockResolvedValue(subscription());
    const store = createMemoryAssessmentStore();
    const invoiceId = 'in_org_idempotent';
    const record = await persistOrgAssessment({
      store,
      invoiceId,
      outcome: 'charged',
    });
    const invoice = paidOrgInvoice({
      invoiceId,
      assessmentKey: record.assessmentKey,
    });
    const { handleOrganizationKiloPassInvoicePaid } = await import('./stripe-adapter');
    const params = {
      invoice,
      serviceFee: {
        store,
        stripe: { invoices: { listLineItems } } as KiloPassServiceFeeSettlementStripe,
      },
    };

    await handleOrganizationKiloPassInvoicePaid(params);
    const first = await store.findByAssessmentKey(record.assessmentKey);
    await handleOrganizationKiloPassInvoicePaid(params);
    const second = await store.findByAssessmentKey(record.assessmentKey);
    expect(second?.settledAt).toBe(first?.settledAt);
    expect(second).toMatchObject({
      settledProductMinor: 4_900,
      chargedFeeMinor: 245,
      outcome: 'charged',
    });
    expect(activatePaidAgreement).toHaveBeenCalledTimes(2);
  });
});
