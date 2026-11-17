import { client } from '@kilocode/web-shared/lib/stripe-client';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { auto_top_up_configs } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { maybePerformAutoTopUp } from '@kilocode/web-shared/lib/autoTopUp';
import { sendAutoTopUpFailedEmail } from '@kilocode/web-shared/lib/email';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import Stripe from 'stripe';

const toMicrodollars = (dollars: number) => dollars * 1_000_000;

jest.mock('@kilocode/web-shared/lib/email', () => ({
  sendAutoTopUpFailedEmail: jest.fn().mockResolvedValue({ sent: true }),
}));

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  client: {
    invoices: {
      create: jest.fn(),
      update: jest.fn(),
      pay: jest.fn(),
    },
    invoiceItems: {
      create: jest.fn(),
    },
  },
}));

// Delegates to the real lookup so the failure-path tests keep reading the seeded rows; a test
// overrides one call to simulate a row that disappeared between the balance snapshot and the lock.
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/user/find-user-by-id');
  return { findUserById: jest.fn(actual.findUserById) };
});

async function seedUserWithAutoTopUpConfig(tag: string) {
  const user = await insertTestUser({
    google_user_email: `attempt-lock-${tag}-${Date.now()}@example.com`,
    auto_top_up_enabled: true,
    stripe_customer_id: `cus_attempt_lock_${tag}_${Date.now()}`,
    total_microdollars_acquired: 0,
    microdollars_used: toMicrodollars(10),
  });
  const [config] = await db
    .insert(auto_top_up_configs)
    .values({
      owned_by_user_id: user.id,
      stripe_payment_method_id: 'pm_attempt_lock',
      amount_cents: 2000,
    })
    .returning();
  return { user, config };
}

function mockInvoiceUntilPayment(invoiceId: string) {
  (client.invoices.create as jest.Mock).mockResolvedValue({
    id: invoiceId,
    created: 1_700_000_000,
  });
  (client.invoices.update as jest.Mock).mockResolvedValue({
    id: invoiceId,
    created: 1_700_000_000,
  });
  (client.invoiceItems.create as jest.Mock).mockResolvedValue({ id: `ii_${invoiceId}` });
}

async function readAttemptStartedAt(configId: string) {
  const row = await db.query.auto_top_up_configs.findFirst({
    where: eq(auto_top_up_configs.id, configId),
  });
  return row?.attempt_started_at ?? null;
}

describe('auto-top-up attempt lock', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.clearAllMocks();
  });

  test('releases the lock when the entity row is missing after the lock is taken', async () => {
    const { user, config } = await seedUserWithAutoTopUpConfig('missing-row');
    jest.mocked(findUserById).mockResolvedValueOnce(undefined);

    await expect(maybePerformAutoTopUp(user)).rejects.toThrow(`User not found:${user.id}`);

    expect(await readAttemptStartedAt(config.id)).toBeNull();

    // The next attempt is not held back by the failed one: it starts a charge right away.
    mockInvoiceUntilPayment('inv_attempt_lock_retry');
    (client.invoices.pay as jest.Mock).mockRejectedValue(
      new Stripe.errors.StripeCardError({
        type: 'card_error',
        message: 'Your card was declined.',
        decline_code: 'generic_decline',
        code: 'card_declined',
      })
    );
    (client.invoices.create as jest.Mock).mockClear();
    await maybePerformAutoTopUp(user);
    expect(client.invoices.create).toHaveBeenCalledTimes(1);
  });

  test('releases the lock when the failure notification throws', async () => {
    const { user, config } = await seedUserWithAutoTopUpConfig('email-failure');
    const invoiceId = 'inv_attempt_lock_email_failure';
    mockInvoiceUntilPayment(invoiceId);
    (client.invoices.pay as jest.Mock).mockRejectedValue(
      new Stripe.errors.StripeCardError({
        type: 'card_error',
        message: 'Your card was declined.',
        decline_code: 'generic_decline',
        code: 'card_declined',
      })
    );
    (sendAutoTopUpFailedEmail as jest.Mock).mockRejectedValueOnce(
      new Error('notification service unavailable')
    );

    await expect(maybePerformAutoTopUp(user)).rejects.toThrow('notification service unavailable');

    const row = await db.query.auto_top_up_configs.findFirst({
      where: eq(auto_top_up_configs.id, config.id),
    });
    expect(row?.disabled_reason).toBe('generic_decline');
    expect(row?.attempt_started_at).toBeNull();
  });

  test('holds the lock until the paid invoice webhook posts credits', async () => {
    const { user, config } = await seedUserWithAutoTopUpConfig('paid');
    const invoiceId = 'inv_attempt_lock_paid';
    mockInvoiceUntilPayment(invoiceId);
    (client.invoices.pay as jest.Mock).mockResolvedValue({ id: invoiceId, status: 'paid' });

    await maybePerformAutoTopUp(user);

    expect(await readAttemptStartedAt(config.id)).not.toBeNull();
  });
});
