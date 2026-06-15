import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { credit_transactions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { POST } from './route';

jest.mock('@/lib/user/server');

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
