import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { blacklisted_domains } from '@kilocode/db/schema';
import type { UsersApiResponse } from '@/types/admin';
import { GET } from './route';

jest.mock('@kilocode/web-shared/lib/user/server');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

describe('GET /admin/api/users', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('flags users whose email domain or a parent domain is blacklisted', async () => {
    const admin = await insertTestUser({
      google_user_email: 'admin@admin.example',
      is_admin: true,
    });
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });
    await db.insert(blacklisted_domains).values([{ domain: 'spam.org' }, { domain: 'unused.io' }]);
    const exact = await insertTestUser({ google_user_email: 'exact@spam.org' });
    const subdomain = await insertTestUser({ google_user_email: 'sub@Mail.Spam.org' });
    const lookalike = await insertTestUser({ google_user_email: 'lookalike@notspam.org' });

    const response = await GET(new NextRequest('http://localhost:3000/admin/api/users?limit=100'));
    const body = (await response.json()) as UsersApiResponse;

    expect(response.status).toBe(200);
    expect(
      Object.fromEntries(body.users.map(user => [user.id, user.is_blacklisted_by_domain]))
    ).toEqual({
      [admin.id]: false,
      [exact.id]: true,
      [subdomain.id]: true,
      [lookalike.id]: false,
    });
  });

  it('omits credential and token columns from every returned user', async () => {
    const admin = await insertTestUser({
      google_user_email: 'admin@admin.example',
      is_admin: true,
    });
    mockedGetUserFromAuth.mockResolvedValue({ user: admin, authFailedResponse: null });
    const appStoreAccountToken = crypto.randomUUID();
    const target = await insertTestUser({
      google_user_email: 'target@example.com',
      api_token_pepper: 'route-test-api-pepper',
      web_session_pepper: 'route-test-web-pepper',
      app_store_account_token: appStoreAccountToken,
    });

    const response = await GET(new NextRequest('http://localhost:3000/admin/api/users?limit=100'));
    const body = (await response.json()) as UsersApiResponse;

    expect(response.status).toBe(200);
    expect(body.users.map(user => user.id)).toContain(target.id);
    for (const user of body.users) {
      expect(user).not.toHaveProperty('api_token_pepper');
      expect(user).not.toHaveProperty('web_session_pepper');
      expect(user).not.toHaveProperty('app_store_account_token');
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('route-test-api-pepper');
    expect(serialized).not.toContain('route-test-web-pepper');
    expect(serialized).not.toContain(appStoreAccountToken);
  });
});
