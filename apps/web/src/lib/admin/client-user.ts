import type { User } from '@kilocode/db/schema';

/**
 * `kilocode_users` columns that must never reach a browser: the API-token and
 * web-session peppers that bind credentials to the account, and the App Store
 * account token used to attribute store transactions.
 */
export type ClientUser = Omit<
  User,
  'api_token_pepper' | 'web_session_pepper' | 'app_store_account_token'
>;

export function toClientUser(user: User): ClientUser {
  const {
    api_token_pepper: _apiTokenPepper,
    web_session_pepper: _webSessionPepper,
    app_store_account_token: _appStoreAccountToken,
    ...clientUser
  } = user;
  return clientUser;
}
