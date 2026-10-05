/**
 * Regression tests for `createOrReuseKiloPassCheckoutSession` durable reporting coupling: the
 * caller's `onSession` hook enqueues inside the checkout transaction for the charged session,
 * whether it was created or reused, with a stable session-derived id. Uses the real test database;
 * the Stripe client is stubbed.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { eq, inArray } from 'drizzle-orm';
import type Stripe from 'stripe';

import { enqueueChargeAttempted } from '@/lib/bouncer/credit-events';
import { db } from '@/lib/drizzle';
import type * as CheckoutSession from '@/lib/kilo-pass/checkout-session';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { bouncer_credit_event_outbox } from '@kilocode/db/schema';

jest.mock('@/lib/stripe-client', () => ({
  client: {
    checkout: {
      sessions: { list: jest.fn(), expire: jest.fn() },
    },
    subscriptions: { list: jest.fn() },
  },
}));

type StripeClientMock = {
  client: {
    checkout: {
      sessions: {
        list: jest.Mock<() => Promise<{ data: Stripe.Checkout.Session[]; has_more: boolean }>>;
        expire: jest.Mock<() => Promise<unknown>>;
      };
    };
    subscriptions: {
      list: jest.Mock<() => Promise<{ data: Stripe.Subscription[]; has_more: boolean }>>;
    };
  };
};
const stripeClient = jest.requireMock<StripeClientMock>('@/lib/stripe-client');
const mockListSessions = stripeClient.client.checkout.sessions.list;
const mockExpireSession = stripeClient.client.checkout.sessions.expire;
const mockListSubscriptions = stripeClient.client.subscriptions.list;

// SWC static imports do not see jest.mock replacements on the same module id, so the SUT is loaded
// after the Stripe client mock is registered; otherwise the real client runs with a test key.
let createOrReuseKiloPassCheckoutSession: typeof CheckoutSession.createOrReuseKiloPassCheckoutSession;

beforeAll(() => {
  ({ createOrReuseKiloPassCheckoutSession } = jest.requireActual<typeof CheckoutSession>(
    '@/lib/kilo-pass/checkout-session'
  ));
});

type CreateSessionMock = (tx: unknown) => Promise<CheckoutSession.KiloPassCheckoutSessionForReport>;
type OnSessionMock = Parameters<typeof createOrReuseKiloPassCheckoutSession>[0]['onSession'];

const METADATA = {
  type: 'kilo-pass',
  kiloUserId: 'placeholder',
  tier: 'tier19',
  cadence: 'monthly',
};

function stripeSession(id: string, overrides: Partial<Stripe.Checkout.Session> = {}) {
  return {
    id,
    created: 1_700_000_000,
    url: `https://checkout.stripe.test/${id}`,
    amount_total: 1900,
    metadata: { ...METADATA },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

/** Fixture owners created by this suite, so cleanup is scoped to this suite's rows only. */
const createdUserIds: string[] = [];

function outboxRowsFor(userId: string) {
  return db
    .select()
    .from(bouncer_credit_event_outbox)
    .where(eq(bouncer_credit_event_outbox.user_id, userId));
}

describe('createOrReuseKiloPassCheckoutSession durable reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListSubscriptions.mockResolvedValue({ data: [], has_more: false });
    mockExpireSession.mockResolvedValue({});
  });

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await db
        .delete(bouncer_credit_event_outbox)
        .where(inArray(bouncer_credit_event_outbox.user_id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await db
        .delete(bouncer_credit_event_outbox)
        .where(inArray(bouncer_credit_event_outbox.user_id, createdUserIds));
    }
  });

  async function insertOwner() {
    const user = await insertTestUser();
    createdUserIds.push(user.id);
    return user;
  }

  it('enqueues for a reused session with a stable session-derived id', async () => {
    const user = await insertOwner();
    const session = stripeSession('cs_reused', {
      metadata: { ...METADATA, kiloUserId: user.id },
    });
    mockListSessions.mockResolvedValue({ data: [session], has_more: false });
    const createSession = jest.fn<CreateSessionMock>();

    const result = await createOrReuseKiloPassCheckoutSession({
      userId: user.id,
      stripeCustomerId: 'cus_test',
      metadata: METADATA,
      createSession,
      onSession: (tx, chargeSession) =>
        enqueueChargeAttempted(tx, {
          eventId: `kilo-pass-checkout:${chargeSession.id}`,
          flow: 'kilo_pass',
          userId: user.id,
          amountCents: chargeSession.amountCents ?? chargeSession.amount_total ?? 0,
          accountCreatedAt: '2026-01-01T00:00:00.000Z',
        }),
    });

    expect(result.url).toBe('https://checkout.stripe.test/cs_reused');
    expect(createSession).not.toHaveBeenCalled();
    const rows = await outboxRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe('kilo-pass-checkout:cs_reused');
    expect(rows[0].event_type).toBe('charge.attempted');
  });

  it('enqueues for a created session inside the checkout transaction', async () => {
    const user = await insertOwner();
    mockListSessions.mockResolvedValue({ data: [], has_more: false });
    const createSession = jest.fn<CreateSessionMock>(async () =>
      stripeSession('cs_created', { metadata: { ...METADATA, kiloUserId: user.id } })
    );

    const result = await createOrReuseKiloPassCheckoutSession({
      userId: user.id,
      stripeCustomerId: 'cus_test',
      metadata: METADATA,
      createSession,
      onSession: (tx, chargeSession) =>
        enqueueChargeAttempted(tx, {
          eventId: `kilo-pass-checkout:${chargeSession.id}`,
          flow: 'kilo_pass',
          userId: user.id,
          amountCents: 1900,
          accountCreatedAt: '2026-01-01T00:00:00.000Z',
        }),
    });

    expect(result.url).toBe('https://checkout.stripe.test/cs_created');
    expect(createSession).toHaveBeenCalledTimes(1);
    const rows = await outboxRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe('kilo-pass-checkout:cs_created');
  });

  it('rolls back a failed enqueue and recovers exactly one row when the session is reused', async () => {
    const user = await insertOwner();
    mockListSessions.mockResolvedValueOnce({ data: [], has_more: false });
    const createSession = jest.fn<CreateSessionMock>(async () =>
      stripeSession('cs_retry', { metadata: { ...METADATA, kiloUserId: user.id } })
    );

    let failEnqueue = true;
    const onSession: OnSessionMock = (tx, chargeSession) => {
      if (failEnqueue) {
        failEnqueue = false;
        throw new Error('simulated enqueue failure');
      }
      return enqueueChargeAttempted(tx, {
        eventId: `kilo-pass-checkout:${chargeSession.id}`,
        flow: 'kilo_pass',
        userId: user.id,
        amountCents: 1900,
        accountCreatedAt: '2026-01-01T00:00:00.000Z',
      });
    };

    await expect(
      createOrReuseKiloPassCheckoutSession({
        userId: user.id,
        stripeCustomerId: 'cus_test',
        metadata: METADATA,
        createSession,
        onSession,
      })
    ).rejects.toThrow('simulated enqueue failure');
    expect(await outboxRowsFor(user.id)).toHaveLength(0);

    // Retry: the created session is now listed and reused, so the stable id enqueues once.
    mockListSessions.mockResolvedValueOnce({
      data: [stripeSession('cs_retry', { metadata: { ...METADATA, kiloUserId: user.id } })],
      has_more: false,
    });
    await createOrReuseKiloPassCheckoutSession({
      userId: user.id,
      stripeCustomerId: 'cus_test',
      metadata: METADATA,
      createSession,
      onSession,
    });

    const rows = await outboxRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe('kilo-pass-checkout:cs_retry');
  });
});
