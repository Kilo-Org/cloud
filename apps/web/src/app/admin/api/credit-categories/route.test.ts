import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { credit_transactions } from '@kilocode/db/schema';
import { getUserFromAuth } from '@/lib/user/server';
import { defineTestUser, insertTestUser } from '@/tests/helpers/user.helper';
import { GET } from './route';

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

function createRequest() {
  return new NextRequest('http://localhost:3000/admin/api/credit-categories');
}

describe('GET /admin/api/credit-categories', () => {
  beforeEach(() => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: defineTestUser({ is_admin: true }),
      authFailedResponse: null,
    });
  });

  it('returns credit category stats for a current admin', async () => {
    const user = await insertTestUser();
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      credit_category: null,
      amount_microdollars: 1_000_000,
      is_free: false,
    });

    const response = await GET(createRequest());
    expect(response.status).toBe(200);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    const body = await response.json();
    expect(body).toHaveProperty('creditCategories');
    expect(Array.isArray(body.creditCategories)).toBe(true);
  });

  it('rejects the request before touching the database when authorization fails', async () => {
    const user = await insertTestUser();
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      credit_category: null,
      amount_microdollars: 1_000_000,
      is_free: false,
    });

    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false as const, error: 'Unauthorized' },
        { status: 401 }
      ),
    });

    const selectSpy = jest.spyOn(db, 'select');
    try {
      const response = await GET(createRequest());
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ success: false, error: 'Unauthorized' });
      // The route must return the auth-failure response before ever querying
      // credit_transactions/kilocode_users — not just produce a matching body.
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });
});
