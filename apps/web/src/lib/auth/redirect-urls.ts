import { SSO_SIGNIN_PATH, type AuthErrorType } from '@/lib/auth/constants';

export function authFailureRedirectUrl(error: AuthErrorType, isAccountLinking: boolean): string {
  const baseUrl = isAccountLinking ? '/connected-accounts' : '/users/sign_in';
  return `${baseUrl}?${new URLSearchParams({ error }).toString()}`;
}

export function ssoSignInRedirectUrl(domain: string): string {
  return `${SSO_SIGNIN_PATH}?${new URLSearchParams({ domain }).toString()}`;
}
