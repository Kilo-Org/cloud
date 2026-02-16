import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { GET } from './route';
import { db } from '@/lib/drizzle';
import { kilocode_users, organization_memberships, organizations } from '@/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { failureResult } from '@/lib/maybe-result';
import { getUserFromAuth } from '@/lib/user.server';

jest.mock('@/lib/user.server');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

function makeRequest(search?: string) {
  const url = new URL('http://localhost:3000/api/private/users');
  if (search !== undefined) {
    url.searchParams.set('search', search);
  }
  return new NextRequest(url);
}

async function setAdminAuth() {
  const adminUser = await insertTestUser({ is_admin: true });
  mockedGetUserFromAuth.mockResolvedValue({
    user: adminUser,
    authFailedResponse: null,
  });
  return adminUser;
}

describe('GET /api/private/users', () => {
  beforeEach(() => {
    mockedGetUserFromAuth.mockReset();
  });

  afterEach(async () => {
    // Clean up in FK-safe order
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  test('returns authFailedResponse when admin auth fails', async () => {
    const authFailedResponse = NextResponse.json(failureResult('Unauthorized'), { status: 401 });

    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse,
    });

    const response = await GET(makeRequest('someone@example.com'));

    expect(response).toBe(authFailedResponse);
  });

  test('returns empty list when search term is missing', async () => {
    await setAdminAuth();

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ users: [] });
  });

  test('returns empty list when no users match search term', async () => {
    await setAdminAuth();
    await insertTestUser({ google_user_email: 'other@example.com' });

    const response = await GET(makeRequest('target@example.com'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ users: [] });
  });

  test('returns matching user with organizations', async () => {
    const adminUser = await setAdminAuth();

    const targetUser = await insertTestUser({
      google_user_email: 'target@example.com',
      stripe_customer_id: 'stripe-123',
    });

    const [org] = await db
      .insert(organizations)
      .values({
        name: 'Acme Org',
        auto_top_up_enabled: true,
        plan: 'enterprise',
      })
      .returning();

    await db.insert(organization_memberships).values({
      organization_id: org.id,
      kilo_user_id: targetUser.id,
      role: 'member',
      invited_by: adminUser.id,
    });

    const response = await GET(makeRequest('target@example.com'));

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.users).toHaveLength(1);

    const returnedUser = body.users[0];
    expect(returnedUser).toMatchObject({
      id: targetUser.id,
      stripe_customer_id: 'stripe-123',
    });

    expect(returnedUser.organizations).toHaveLength(1);
    expect(returnedUser.organizations[0]).toMatchObject({
      id: org.id,
      name: 'Acme Org',
      plan: 'enterprise',
    });
  });

  test('trims whitespace in search term', async () => {
    await setAdminAuth();
    const user = await insertTestUser({ google_user_email: 'trimmed@example.com' });

    const response = await GET(makeRequest('  trimmed@example.com  '));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe(user.id);
  });
});
