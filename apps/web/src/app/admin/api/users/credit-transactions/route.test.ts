import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { credit_transactions } from '@kilocode/db/schema';
import { GET } from './route';

jest.mock('@/lib/user/server');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

describe('GET /admin/api/users/credit-transactions', () => {
  it('returns creator details and excludes organization transactions', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    await db.insert(credit_transactions).values([
      {
        kilo_user_id: recipient.id,
        created_by_kilo_user_id: admin.id,
        amount_microdollars: 1_000_000,
        is_free: true,
      },
      {
        kilo_user_id: recipient.id,
        created_by_kilo_user_id: admin.id,
        organization_id: crypto.randomUUID(),
        amount_microdollars: 2_000_000,
        is_free: true,
      },
    ]);

    const response = await GET(
      new NextRequest(
        `http://localhost:3000/admin/api/users/credit-transactions?kilo_user_id=${encodeURIComponent(recipient.id)}`
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.credit_transactions).toHaveLength(1);
    expect(body.credit_transactions[0]).toMatchObject({
      created_by_kilo_user_id: admin.id,
      created_by_user_name: admin.google_user_name,
      created_by_user_email: admin.google_user_email,
    });
  });

  it('returns null creator fields for historical transactions', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const recipient = await insertTestUser();
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });

    await db.insert(credit_transactions).values({
      kilo_user_id: recipient.id,
      amount_microdollars: 1_000_000,
      is_free: true,
    });

    const response = await GET(
      new NextRequest(
        `http://localhost:3000/admin/api/users/credit-transactions?kilo_user_id=${encodeURIComponent(recipient.id)}`
      )
    );
    const body = await response.json();

    expect(body.credit_transactions[0]).toMatchObject({
      created_by_kilo_user_id: null,
      created_by_user_name: null,
      created_by_user_email: null,
    });
  });
});
