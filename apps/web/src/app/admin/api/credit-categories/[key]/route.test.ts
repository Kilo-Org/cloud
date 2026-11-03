import { NextRequest, NextResponse } from 'next/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { credit_transactions } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

const categoryParams = Promise.resolve({ key: '<null:paid>' });

function createRequest(search = '') {
  return new NextRequest(
    `http://localhost:3000/admin/api/credit-categories/%3Cnull:paid%3E${search}`
  );
}

async function insertUserWithPaidCredits(google_user_email?: string) {
  const user = await insertTestUser(google_user_email ? { google_user_email } : {});
  await db.insert(credit_transactions).values({
    kilo_user_id: user.id,
    credit_category: null,
    amount_microdollars: 1_000_000,
    is_free: false,
  });
  return user;
}

describe('GET /admin/api/credit-categories/[key]', () => {
  beforeEach(() => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: defineTestUser({ is_admin: true }),
      authFailedResponse: null,
    });
  });

  it('returns users for a current admin', async () => {
    const user = await insertUserWithPaidCredits();

    const response = await GET(createRequest(), { params: categoryParams });
    expect(response.status).toBe(200);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    const body = await response.json();
    expect(body).toHaveProperty('users');
    expect(body.users.map((u: { kilo_user_id: string }) => u.kilo_user_id)).toContain(user.id);
  });

  it('rejects the request before touching the database when authorization fails', async () => {
    await insertUserWithPaidCredits();

    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false as const, error: 'Unauthorized' },
        { status: 401 }
      ),
    });

    const selectSpy = jest.spyOn(db, 'select');
    try {
      const response = await GET(createRequest(), { params: categoryParams });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ success: false, error: 'Unauthorized' });
      // The route must return the auth-failure response before ever querying
      // credit_transactions/kilocode_users — not just produce a matching body.
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });

  it('pages with the default page size when page and limit are absent', async () => {
    await insertUserWithPaidCredits();

    const response = await GET(createRequest(), { params: categoryParams });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(25);
  });

  it('keeps the defaults for empty page and limit values', async () => {
    await insertUserWithPaidCredits();

    const response = await GET(createRequest('?page=&limit='), { params: categoryParams });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(25);
  });

  it.each([10, 25, 50, 100])('accepts the supported page size %i', async limit => {
    await insertUserWithPaidCredits();

    const response = await GET(createRequest(`?page=2&limit=${limit}`), {
      params: categoryParams,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.limit).toBe(limit);
  });

  it.each([
    'limit=30',
    'limit=0',
    'limit=-10',
    'limit=abc',
    'limit=25.5',
    'page=0',
    'page=-1',
    'page=abc',
    'page=1.5',
    'page=10001',
  ])('refuses %s without querying the database', async query => {
    await insertUserWithPaidCredits();

    const selectSpy = jest.spyOn(db, 'select');
    try {
      const response = await GET(createRequest(`?${query}`), { params: categoryParams });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid pagination parameters' });
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });

  it('matches a search value literally when it contains LIKE wildcards', async () => {
    const percentUser = await insertUserWithPaidCredits('wild%card@example.com');
    const percentLookalike = await insertUserWithPaidCredits('wildXcard@example.com');
    const underscoreUser = await insertUserWithPaidCredits('under_score@example.com');
    const underscoreLookalike = await insertUserWithPaidCredits('underXscore@example.com');

    const percentResponse = await GET(createRequest(`?search=${encodeURIComponent('wild%card')}`), {
      params: categoryParams,
    });
    const underscoreResponse = await GET(
      createRequest(`?search=${encodeURIComponent('under_score')}`),
      { params: categoryParams }
    );

    expect(percentResponse.status).toBe(200);
    expect(underscoreResponse.status).toBe(200);
    const percentBody = await percentResponse.json();
    const underscoreBody = await underscoreResponse.json();
    expect(percentBody.users.map((u: { kilo_user_id: string }) => u.kilo_user_id)).toEqual([
      percentUser.id,
    ]);
    expect(underscoreBody.users.map((u: { kilo_user_id: string }) => u.kilo_user_id)).toEqual([
      underscoreUser.id,
    ]);
    expect(percentBody.users.map((u: { kilo_user_id: string }) => u.kilo_user_id)).not.toContain(
      percentLookalike.id
    );
    expect(underscoreBody.users.map((u: { kilo_user_id: string }) => u.kilo_user_id)).not.toContain(
      underscoreLookalike.id
    );
  });
});
