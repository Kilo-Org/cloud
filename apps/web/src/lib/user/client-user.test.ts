import { describe, expect, it } from '@jest/globals';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { toClientUser } from './client-user';

describe('toClientUser', () => {
  it('drops the credential and store-token columns', () => {
    const user = defineTestUser({
      api_token_pepper: 'api-pepper',
      web_session_pepper: 'web-pepper',
      app_store_account_token: crypto.randomUUID(),
    });

    const clientUser = toClientUser(user);

    expect(clientUser).not.toHaveProperty('api_token_pepper');
    expect(clientUser).not.toHaveProperty('web_session_pepper');
    expect(clientUser).not.toHaveProperty('app_store_account_token');
    expect(clientUser.id).toBe(user.id);
    expect(clientUser.google_user_email).toBe(user.google_user_email);
  });

  it('keeps the remaining user columns', () => {
    const user = defineTestUser({ is_admin: true, kiloclaw_early_access: true });

    expect(toClientUser(user)).toEqual(
      expect.objectContaining({ is_admin: true, kiloclaw_early_access: true })
    );
    expect(Object.keys(toClientUser(user))).toHaveLength(Object.keys(user).length - 3);
  });
});
