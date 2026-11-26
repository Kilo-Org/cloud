import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET } from './route';

jest.mock('@kilocode/web-shared/lib/user/server');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

describe('GET /api/user', () => {
  it('returns the signed-in user without credential or token columns', async () => {
    const appStoreAccountToken = crypto.randomUUID();
    const user = defineTestUser({
      api_token_pepper: 'api-user-route-api-pepper',
      web_session_pepper: 'api-user-route-web-pepper',
      app_store_account_token: appStoreAccountToken,
    });
    mockedGetUserFromAuth.mockResolvedValue({ user, authFailedResponse: null });

    const response = await GET();
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({ id: user.id, google_user_email: user.google_user_email })
    );
    expect(body).not.toHaveProperty('api_token_pepper');
    expect(body).not.toHaveProperty('web_session_pepper');
    expect(body).not.toHaveProperty('app_store_account_token');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('api-user-route-api-pepper');
    expect(serialized).not.toContain('api-user-route-web-pepper');
    expect(serialized).not.toContain(appStoreAccountToken);
  });
});
