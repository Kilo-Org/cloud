import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { promoCreditCategoriesByKey } from '@kilocode/web-shared/lib/promoCreditCategories';
import { eq } from 'drizzle-orm';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

function request(body: object, force200 = false) {
  return new NextRequest(
    `http://localhost:3000/admin/api/users/add-credit${force200 ? '?force_200_response=true' : ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

describe('POST /admin/api/users/add-credit', () => {
  it('preserves disabled-policy paid grants without caller promotional expiry overrides', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });
    const response = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'custom',
        amount_usd: 10,
        creditKind: 'paid',
        credit_expiry_date: '2030-01-01T00:00:00.000Z',
        expiry_hours: 1,
      })
    );
    expect(response.status).toBe(200);
    const credit = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.kilo_user_id, recipient.id),
    });
    expect(credit).toMatchObject({
      is_free: false,
      credit_source: 'admin',
      paid_credit_policy: 'legacy',
      expiry_date: null,
    });
  });

  async function fundedRecipient() {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });
    await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'custom',
        amount_usd: 10,
        credit_expiry_date: '2030-01-01T00:00:00.000Z',
      })
    );
    return recipient;
  }

  async function debits(recipientId: string) {
    const credits = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, recipientId));
    return credits.filter(credit => credit.amount_microdollars < 0);
  }

  it.each(['debit_unregistered', 'credits_expired', 'admin-cancel-refund-kilo-pass', 'custom'])(
    'rejects a debit under %s, which is not an operator-facing negative-amount category',
    async category => {
      const recipient = await fundedRecipient();
      const response = await POST(
        request({
          email: recipient.google_user_email,
          credit_category: category,
          amount_usd: -2,
          description: 'Correction',
        })
      );
      expect(response.status).toBe(400);
      expect(await debits(recipient.id)).toHaveLength(0);
    }
  );

  it('retires debited principal under a registered non-idempotent debit category on every request', async () => {
    const recipient = await fundedRecipient();
    const debit = {
      email: recipient.google_user_email,
      credit_category: 'manual_decrement',
      amount_usd: -2,
      description: 'Correction',
    };
    expect((await POST(request(debit))).status).toBe(200);
    const credits = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, recipient.id));
    expect(credits.find(credit => credit.amount_microdollars > 0)?.retired_microdollars).toBe(
      2_000_000
    );
    expect((await POST(request(debit))).status).toBe(200);
    expect(await debits(recipient.id)).toHaveLength(2);
  });

  it('replays an idempotent negative-amount category without a second debit', async () => {
    const category = `idempotent_decrement_${crypto.randomUUID()}`;
    const lookup = promoCreditCategoriesByKey.get.bind(promoCreditCategoriesByKey);
    const spy = jest.spyOn(promoCreditCategoriesByKey, 'get').mockImplementation(key =>
      key === category
        ? {
            credit_category: category,
            adminUI_label: 'Idempotent decrement',
            expect_negative_amount: true,
            is_idempotent: true,
          }
        : lookup(key)
    );
    try {
      const recipient = await fundedRecipient();
      const debit = {
        email: recipient.google_user_email,
        credit_category: category,
        amount_usd: -2,
        description: 'Correction',
      };
      expect((await POST(request(debit))).status).toBe(200);
      expect((await POST(request(debit))).status).toBe(400);
      expect(await debits(recipient.id)).toHaveLength(1);
      const [user] = await db
        .select()
        .from(kilocode_users)
        .where(eq(kilocode_users.id, recipient.id));
      expect(user.total_microdollars_acquired - user.microdollars_used).toBe(8_000_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a positive grant whose credit_expiry_date is in the past', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'custom',
        amount_usd: 10,
        creditKind: 'promotional',
        credit_expiry_date: '2024-06-01T00:00:00.000Z',
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Credit expiry date must be in the future',
    });
    expect(
      await db
        .select({ id: credit_transactions.id })
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, recipient.id))
    ).toHaveLength(0);
  });

  it('reports an already applied idempotent grant instead of a past expiry on replay', async () => {
    const categoryKey = `expiry-replay-${crypto.randomUUID()}`;
    const lookup = promoCreditCategoriesByKey.get.bind(promoCreditCategoriesByKey);
    const template = lookup('custom');
    const spy = jest.spyOn(promoCreditCategoriesByKey, 'get').mockImplementation(key =>
      key === categoryKey && template
        ? {
            ...template,
            credit_category: categoryKey,
            adminUI_label: 'Expiry replay grant',
            expect_negative_amount: false,
            is_idempotent: true,
          }
        : lookup(key)
    );
    try {
      const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
      const recipient = await insertTestUser();
      mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });
      const grant = {
        email: recipient.google_user_email,
        credit_category: categoryKey,
        amount_usd: 10,
        creditKind: 'promotional',
        credit_expiry_date: '2030-01-01T00:00:00.000Z',
      };
      expect((await POST(request(grant))).status).toBe(200);

      const replay = await POST(
        request({ ...grant, credit_expiry_date: '2024-06-01T00:00:00.000Z' })
      );

      expect(replay.status).toBe(400);
      await expect(replay.json()).resolves.toMatchObject({
        error: expect.stringContaining('has already been applied'),
      });
      expect(
        await db
          .select({ id: credit_transactions.id })
          .from(credit_transactions)
          .where(eq(credit_transactions.kilo_user_id, recipient.id))
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('treats a category row that cannot conflict on insert as not yet applied', async () => {
    const categoryKey = `expiry-replay-stale-${crypto.randomUUID()}`;
    const lookup = promoCreditCategoriesByKey.get.bind(promoCreditCategoriesByKey);
    const template = lookup('custom');
    const spy = jest.spyOn(promoCreditCategoriesByKey, 'get').mockImplementation(key =>
      key === categoryKey && template
        ? {
            ...template,
            credit_category: categoryKey,
            adminUI_label: 'Expiry replay stale grant',
            expect_negative_amount: false,
            is_idempotent: true,
          }
        : lookup(key)
    );
    try {
      const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
      const recipient = await insertTestUser();
      mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });
      // A row written while the category was not idempotent stays outside the
      // partial unique index, so the grant insert does not conflict with it.
      await db.insert(credit_transactions).values({
        kilo_user_id: recipient.id,
        created_by_kilo_user_id: admin.id,
        credit_category: categoryKey,
        amount_microdollars: 1_000_000,
        is_free: true,
        check_category_uniqueness: false,
      });

      const response = await POST(
        request({
          email: recipient.google_user_email,
          credit_category: categoryKey,
          amount_usd: 10,
          creditKind: 'promotional',
          credit_expiry_date: '2024-06-01T00:00:00.000Z',
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'Credit expiry date must be in the future',
      });
      expect(
        await db
          .select({ id: credit_transactions.id })
          .from(credit_transactions)
          .where(eq(credit_transactions.kilo_user_id, recipient.id))
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a malformed credit_expiry_date instead of writing an invalid transaction', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'custom',
        amount_usd: 10,
        creditKind: 'promotional',
        credit_expiry_date: 'not-a-date',
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Credit expiry date is not a valid date',
    });
    expect(
      await db
        .select({ id: credit_transactions.id })
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, recipient.id))
    ).toHaveLength(0);
  });

  it('rejects a positive promotional grant whose expiry_hours is negative', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'expiry-hours-negative',
        amount_usd: 10,
        creditKind: 'promotional',
        expiry_hours: -5,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Expiry hours must not be negative',
    });
    expect(
      await db
        .select({ id: credit_transactions.id })
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, recipient.id))
    ).toHaveLength(0);
  });

  it('rejects a negative expiry_hours even when a future credit_expiry_date is supplied', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'expiry-hours-negative-with-date',
        amount_usd: 10,
        creditKind: 'promotional',
        credit_expiry_date: '2030-01-01T00:00:00.000Z',
        expiry_hours: -5,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Expiry hours must not be negative',
    });
    expect(
      await db
        .select({ id: credit_transactions.id })
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, recipient.id))
    ).toHaveLength(0);
  });

  it('stores a future expiry for a positive promotional grant with positive expiry_hours', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'custom',
        amount_usd: 10,
        creditKind: 'promotional',
        expiry_hours: 24,
      })
    );

    expect(response.status).toBe(200);
    const [credit] = await db
      .select({ expiry_date: credit_transactions.expiry_date })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, recipient.id));
    expect(credit.expiry_date).not.toBeNull();
    expect(new Date(credit.expiry_date!).getTime()).toBeGreaterThan(Date.now());
  });

  it('allows an expiry_hours of zero, which means no hours-based expiry', async () => {
    const categoryKey = `expiry-hours-zero-${crypto.randomUUID()}`;
    const lookup = promoCreditCategoriesByKey.get.bind(promoCreditCategoriesByKey);
    const template = lookup('custom');
    const spy = jest
      .spyOn(promoCreditCategoriesByKey, 'get')
      .mockImplementation(key =>
        key === categoryKey && template
          ? { ...template, credit_category: categoryKey }
          : lookup(key)
      );
    try {
      const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
      const recipient = await insertTestUser();
      mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

      const response = await POST(
        request({
          email: recipient.google_user_email,
          credit_category: categoryKey,
          amount_usd: 10,
          creditKind: 'promotional',
          credit_expiry_date: '2030-01-01T00:00:00.000Z',
          expiry_hours: 0,
        })
      );

      expect(response.status).toBe(200);
      const [credit] = await db
        .select({ expiry_date: credit_transactions.expiry_date })
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, recipient.id));
      expect(new Date(credit.expiry_date!).getTime()).toBe(
        new Date('2030-01-01T00:00:00.000Z').getTime()
      );
      expect(new Date(credit.expiry_date!).getTime()).toBeGreaterThan(Date.now());
    } finally {
      spy.mockRestore();
    }
  });

  it('allows a past credit_expiry_date on a debit, which stores no expiry', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'manual_decrement',
        amount_usd: -2,
        description: 'Correction',
        creditKind: 'promotional',
        credit_expiry_date: '2024-06-01T00:00:00.000Z',
      })
    );

    expect(response.status).toBe(200);
    const debitsRows = (
      await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, recipient.id))
    ).filter(credit => credit.amount_microdollars < 0);
    expect(debitsRows).toHaveLength(1);
    expect(debitsRows[0].expiry_date).toBeNull();
  });

  it('allows a negative expiry_hours on a debit, which stores no expiry', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'manual_decrement',
        amount_usd: -2,
        description: 'Correction',
        creditKind: 'promotional',
        expiry_hours: -5,
      })
    );

    expect(response.status).toBe(200);
    const debitsRows = (
      await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, recipient.id))
    ).filter(credit => credit.amount_microdollars < 0);
    expect(debitsRows).toHaveLength(1);
    expect(debitsRows[0].expiry_date).toBeNull();
  });

  it('returns 403 without credit management access even when force-200 is requested', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const response = await POST(
      request(
        {
          email: recipient.google_user_email,
          credit_category: 'custom',
          amount_usd: 10,
        },
        true
      )
    );

    expect(response.status).toBe(403);
    const transactions = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, recipient.id));
    expect(transactions).toHaveLength(0);
  });

  it('stores the authenticated operator on positive and negative adjustments', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    const positiveResponse = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'custom',
        amount_usd: 10,
      })
    );
    const negativeResponse = await POST(
      request({
        email: recipient.google_user_email,
        credit_category: 'manual_decrement',
        amount_usd: -2,
        description: 'Correction',
      })
    );

    expect(positiveResponse.status).toBe(200);
    expect(negativeResponse.status).toBe(200);

    const transactions = await db
      .select({
        kilo_user_id: credit_transactions.kilo_user_id,
        created_by_kilo_user_id: credit_transactions.created_by_kilo_user_id,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, recipient.id));

    expect(transactions).toHaveLength(2);
    expect(transactions).toEqual(
      expect.arrayContaining([
        {
          kilo_user_id: recipient.id,
          created_by_kilo_user_id: admin.id,
          description: 'Correction',
        },
      ])
    );
    expect(
      transactions.every(transaction => transaction.created_by_kilo_user_id === admin.id)
    ).toBe(true);
    expect(
      transactions.every(transaction => !transaction.description?.includes(admin.google_user_email))
    ).toBe(true);
    expect(
      transactions.every(transaction => transaction.created_by_kilo_user_id === admin.id)
    ).toBe(true);
  });
});
