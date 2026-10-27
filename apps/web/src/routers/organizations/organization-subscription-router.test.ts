import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import Stripe from 'stripe';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  organizations,
  organization_memberships,
  organization_seats_purchases,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { client } from '@kilocode/web-shared/lib/stripe-client';
import { retrieveSubscription } from '@/lib/stripe';
import { organizationsSubscriptionRouter } from './organization-subscription-router';

jest.mock('@/lib/stripe', () => ({
  retrieveSubscription: jest.fn(),
  KNOWN_SEAT_PRICE_IDS: new Set(['price_teams_monthly']),
  getPlanForPriceId: jest.fn(() => 'teams'),
  getPriceIdForPlanAndCycle: jest.fn(() => 'price_teams_annual'),
}));

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  client: {
    subscriptionSchedules: {
      create: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
      release: jest.fn(),
    },
  },
}));

const organizationId = randomUUID();
const subscriptionId = `sub_cycle_race_${randomUUID()}`;
const subscription: Stripe.Subscription = {
  id: subscriptionId,
  object: 'subscription',
  application: null,
  application_fee_percent: null,
  automatic_tax: { disabled_reason: null, enabled: false, liability: null },
  billing_cycle_anchor: 1_793_059_200,
  billing_cycle_anchor_config: null,
  billing_mode: { type: 'classic', flexible: null },
  billing_schedules: [],
  billing_thresholds: null,
  cancel_at: null,
  cancel_at_period_end: false,
  canceled_at: null,
  cancellation_details: null,
  collection_method: 'charge_automatically',
  created: 1_793_059_200,
  currency: 'usd',
  customer: 'cus_cycle_race',
  customer_account: null,
  days_until_due: null,
  default_payment_method: null,
  default_source: null,
  description: null,
  discounts: [],
  ended_at: null,
  invoice_settings: {
    account_tax_ids: null,
    custom_fields: null,
    description: null,
    footer: null,
    issuer: { type: 'self' },
  },
  status: 'active',
  schedule: null,
  managed_payments: null,
  metadata: { type: 'seats' },
  items: {
    object: 'list',
    has_more: false,
    url: `/v1/subscription_items?subscription=${subscriptionId}`,
    data: [
      {
        id: 'si_paid',
        object: 'subscription_item',
        billing_thresholds: null,
        created: 1_793_059_200,
        current_period_start: 1_793_059_200,
        current_period_end: 1_795_737_600,
        current_trial: null,
        discounts: [],
        metadata: {},
        quantity: 2,
        subscription: subscriptionId,
        tax_rates: [],
        plan: {
          id: 'price_teams_monthly',
          object: 'plan',
          active: true,
          amount: 1800,
          amount_decimal: Stripe.Decimal.from(1800),
          billing_scheme: 'per_unit',
          created: 1_793_059_200,
          currency: 'usd',
          interval: 'month',
          interval_count: 1,
          livemode: false,
          metadata: {},
          meter: null,
          nickname: null,
          product: 'prod_teams',
          tiers_mode: null,
          transform_usage: null,
          trial_period_days: null,
          usage_type: 'licensed',
        },
        price: {
          id: 'price_teams_monthly',
          object: 'price',
          active: true,
          billing_scheme: 'per_unit',
          created: 1_793_059_200,
          currency: 'usd',
          custom_unit_amount: null,
          livemode: false,
          lookup_key: null,
          metadata: {},
          nickname: null,
          product: 'prod_teams',
          recurring: {
            interval: 'month',
            interval_count: 1,
            meter: null,
            trial_period_days: null,
            usage_type: 'licensed',
          },
          tax_behavior: 'exclusive',
          tiers_mode: null,
          transform_quantity: null,
          type: 'recurring',
          unit_amount: 1800,
          unit_amount_decimal: Stripe.Decimal.from(1800),
        },
      },
    ],
  },
  latest_invoice: null,
  livemode: false,
  next_pending_invoice_item_invoice: null,
  on_behalf_of: null,
  pause_collection: null,
  payment_settings: null,
  pending_invoice_item_interval: null,
  pending_setup_intent: null,
  pending_update: null,
  start_date: 1_793_059_200,
  test_clock: null,
  transfer_data: null,
  trial_end: null,
  trial_settings: null,
  trial_start: null,
};

function attachedSchedule(
  status: Stripe.SubscriptionSchedule.Status = 'active',
  owner = subscriptionId
): Stripe.SubscriptionSchedule {
  return {
    id: 'sub_sched_concurrent_cycle',
    object: 'subscription_schedule',
    application: null,
    billing_mode: { type: 'classic', flexible: null },
    canceled_at: null,
    completed_at: null,
    created: 1_793_059_200,
    current_phase: null,
    customer: 'cus_cycle_race',
    customer_account: null,
    default_settings: {
      application_fee_percent: null,
      billing_cycle_anchor: 'automatic',
      billing_thresholds: null,
      collection_method: 'charge_automatically',
      default_payment_method: null,
      description: null,
      invoice_settings: {
        account_tax_ids: null,
        custom_fields: null,
        days_until_due: null,
        description: null,
        footer: null,
        issuer: { type: 'self' },
      },
      on_behalf_of: null,
      transfer_data: null,
    },
    end_behavior: 'release',
    livemode: false,
    phases: [],
    released_at: null,
    released_subscription: null,
    status,
    subscription: owner,
    metadata: { origin: 'billing-cycle-change' },
    test_clock: null,
  };
}

function duplicateAttachmentError() {
  return Object.assign(
    new Error('You cannot migrate a subscription that is already attached to a schedule.'),
    {
      type: 'StripeInvalidRequestError',
    }
  );
}

let user: User;

async function changeBillingCycle() {
  const caller = organizationsSubscriptionRouter.createCaller({ user, headersList: new Headers() });
  return caller.changeBillingCycle({ organizationId, targetCycle: 'annual' });
}

async function expectOriginalFailure(error: Error) {
  try {
    await changeBillingCycle();
    throw new Error('Expected schedule creation to fail');
  } catch (caught) {
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', cause: error });
  }
}

beforeAll(async () => {
  user = await insertTestUser();
  await db.insert(organizations).values({
    id: organizationId,
    name: 'Billing cycle race regression',
    created_by_kilo_user_id: user.id,
  });
  await db
    .insert(organization_memberships)
    .values({ organization_id: organizationId, kilo_user_id: user.id, role: 'owner' });
  await db.insert(organization_seats_purchases).values({
    organization_id: organizationId,
    subscription_stripe_id: subscriptionId,
    subscription_status: 'active',
    seat_count: 2,
    amount_usd: 36,
    starts_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(retrieveSubscription).mockReset();
  jest.mocked(retrieveSubscription).mockResolvedValueOnce(subscription);
  jest.mocked(client.subscriptionSchedules.create).mockReset();
  jest.mocked(client.subscriptionSchedules.retrieve).mockReset();
});

describe('concurrent organization billing cycle changes', () => {
  it('returns BAD_REQUEST for an observed code-less provider refusal with a newly attached active schedule', async () => {
    jest.mocked(client.subscriptionSchedules.create).mockRejectedValue(duplicateAttachmentError());
    jest
      .mocked(retrieveSubscription)
      .mockResolvedValueOnce({ ...subscription, schedule: attachedSchedule() });

    await expect(changeBillingCycle()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(retrieveSubscription).toHaveBeenNthCalledWith(2, subscriptionId);
    expect(client.subscriptionSchedules.update).not.toHaveBeenCalled();
    expect(client.subscriptionSchedules.release).not.toHaveBeenCalled();
  });

  it('resolves an attached schedule reference and rejects a not-started schedule without changing it', async () => {
    const schedule = attachedSchedule('not_started');
    jest.mocked(client.subscriptionSchedules.create).mockRejectedValue(duplicateAttachmentError());
    jest
      .mocked(retrieveSubscription)
      .mockResolvedValueOnce({ ...subscription, schedule: schedule.id });
    jest.mocked(client.subscriptionSchedules.retrieve).mockResolvedValue({
      ...schedule,
      lastResponse: { headers: {}, requestId: 'req_concurrent_schedule', statusCode: 200 },
    });

    await expect(changeBillingCycle()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(client.subscriptionSchedules.retrieve).toHaveBeenCalledWith(schedule.id);
    expect(client.subscriptionSchedules.release).not.toHaveBeenCalled();
  });

  it.each(['released', 'completed', 'canceled'] as const)(
    'preserves the provider refusal when the schedule is %s',
    async status => {
      const error = duplicateAttachmentError();
      jest.mocked(client.subscriptionSchedules.create).mockRejectedValue(error);
      jest
        .mocked(retrieveSubscription)
        .mockResolvedValueOnce({ ...subscription, schedule: attachedSchedule(status) });

      await expectOriginalFailure(error);
    }
  );

  it('does not classify a schedule belonging to another subscription as this race', async () => {
    const error = duplicateAttachmentError();
    jest.mocked(client.subscriptionSchedules.create).mockRejectedValue(error);
    jest.mocked(retrieveSubscription).mockResolvedValueOnce({
      ...subscription,
      schedule: attachedSchedule('active', 'sub_other'),
    });

    await expectOriginalFailure(error);
  });

  it('preserves an unrelated invalid request when no schedule is attached', async () => {
    const error = Object.assign(new Error('Invalid request'), {
      type: 'StripeInvalidRequestError',
    });
    jest.mocked(client.subscriptionSchedules.create).mockRejectedValue(error);
    jest.mocked(retrieveSubscription).mockResolvedValueOnce(subscription);

    await expectOriginalFailure(error);
  });

  it('preserves an unrelated connection error without another provider read', async () => {
    const error = Object.assign(new Error('Connection failed'), { type: 'StripeConnectionError' });
    jest.mocked(client.subscriptionSchedules.create).mockRejectedValue(error);

    await expectOriginalFailure(error);

    expect(retrieveSubscription).toHaveBeenCalledTimes(1);
  });

  it('preserves the original provider refusal when the confirming read fails', async () => {
    const error = duplicateAttachmentError();
    jest.mocked(client.subscriptionSchedules.create).mockRejectedValue(error);
    jest.mocked(retrieveSubscription).mockRejectedValueOnce(new Error('Read failed'));

    await expectOriginalFailure(error);
  });
});
