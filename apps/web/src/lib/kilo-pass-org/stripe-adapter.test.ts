import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type Stripe from 'stripe';

const retrieve =
  jest.fn<
    (id: string, params?: Stripe.SubscriptionRetrieveParams) => Promise<Stripe.Subscription>
  >();
const update =
  jest.fn<(id: string, input: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription>>();
const scheduleCreate = jest.fn<(input: unknown) => Promise<{ id: string }>>();
const scheduleUpdate = jest.fn<(id: string, input: unknown) => Promise<unknown>>();
const scheduleRetrieve = jest.fn<(id: string) => Promise<Stripe.SubscriptionSchedule>>();
const select = jest.fn();
const updateDb = jest.fn();
const updateSet = jest.fn();
const activatePaidAgreement = jest.fn();
const createParentSupplement = jest.fn();
const createPendingAgreement = jest.fn<(input: unknown) => Promise<{ agreementId: string }>>();
const bindProviderSeatAddOnItem = jest.fn();

jest.mock('@/lib/stripe-client', () => ({
  client: {
    subscriptions: { retrieve, update },
    subscriptionSchedules: {
      create: scheduleCreate,
      update: scheduleUpdate,
      retrieve: scheduleRetrieve,
    },
  },
}));
jest.mock('@/lib/drizzle', () => ({
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
  suspendAgreementForPaymentReview: jest.fn(),
}));
jest.mock('@/lib/kilo-pass/stripe-price-ids.server', () => ({
  getStripePriceIdForKiloPass: () => 'price_pass',
}));
jest.mock('@/lib/organizations/stripe-seat-line-items', () => ({
  isSeatLineItem: (item: { id: string }) => item.id === 'si_seat',
}));

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

function dbAgreement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agreement_1',
    provider_subscription_id: 'sub_1',
    provider_seat_add_on_item_id: 'si_pass',
    purchased_pass_capacity: 3,
    issuance_anchor_at: '2026-01-01T00:00:00.000Z',
    state: 'active',
    ...overrides,
  };
}

describe('organization Kilo Pass Stripe adapter', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    const rows = [dbAgreement()];
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => rows,
          orderBy: () => ({ limit: async () => rows }),
        }),
      }),
    });
    updateSet.mockReturnValue({ where: async () => undefined });
    updateDb.mockReturnValue({ set: updateSet });
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

  test('returns a PaymentIntent client secret for payment authentication', async () => {
    retrieve.mockResolvedValue(subscription());
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1' });
    update.mockResolvedValue({
      ...subscription(),
      latest_invoice: {
        payment_intent: { status: 'requires_action', client_secret: 'pi_secret_1' },
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
    ).resolves.toEqual({ kind: 'payment_action', clientSecret: 'pi_secret_1' });
    expect(update).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({
        payment_behavior: 'allow_incomplete',
        proration_behavior: 'always_invoice',
      })
    );
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
    retrieve.mockResolvedValue(subscription());
    createPendingAgreement.mockResolvedValue({ agreementId: 'agreement_1' });
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
    expect(activatePaidAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ agreementId: 'agreement_1' })
    );
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

  test('schedules removal of only the pass item at renewal', async () => {
    retrieve.mockResolvedValue(subscription());
    scheduleCreate.mockResolvedValue({ id: 'sub_sched_1' });
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await scheduleOrganizationKiloPassCancellation({
      providerSubscriptionId: 'sub_1',
      providerSeatAddOnItemId: 'si_pass',
    });
    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: 'sub_1' });
    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sub_sched_1',
      expect.objectContaining({
        metadata: { origin: 'kilo-pass-org-cancellation' },
        phases: expect.arrayContaining([
          expect.objectContaining({ items: [{ price: 'price_seat', quantity: 9 }] }),
        ]),
      })
    );
  });

  test('fails closed instead of mistaking a billing-cycle schedule for pass removal', async () => {
    const billingCycleSchedule = {
      id: 'sched_cycle',
      status: 'active',
      metadata: { origin: 'billing-cycle-change' },
      phases: [
        { items: [{ price: 'price_pass', quantity: 9 }] },
        { items: [{ price: 'price_pass_yearly', quantity: 9 }] },
      ],
    } as unknown as Stripe.SubscriptionSchedule;
    retrieve.mockResolvedValue(subscription({ schedule: billingCycleSchedule }));
    const { scheduleOrganizationKiloPassCancellation } = await import('./stripe-adapter');

    await expect(
      scheduleOrganizationKiloPassCancellation({
        providerSubscriptionId: 'sub_1',
        providerSeatAddOnItemId: 'si_pass',
      })
    ).rejects.toThrow('SCHEDULE_REWRITE_UNSAFE');
    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
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

  test('reverses a scheduled cancellation for an active agreement', async () => {
    const { handleOrganizationKiloPassSubscriptionEvent } = await import('./stripe-adapter');
    select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [dbAgreement({ state: 'cancel_at_period_end' })],
        }),
      }),
    });

    await expect(handleOrganizationKiloPassSubscriptionEvent(subscription())).resolves.toBe(true);
    expect(updateSet).toHaveBeenCalledWith({
      state: 'active',
      cancellation_effective_at: null,
    });
  });
});
