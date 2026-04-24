import { authFailureRedirectUrl, ssoSignInRedirectUrl } from '@/lib/auth/redirect-urls';

describe('auth redirect URLs', () => {
  it('does not include email addresses on auth failure redirects', () => {
    const url = authFailureRedirectUrl('BLOCKED', false);

    expect(url).toBe('/users/sign_in?error=BLOCKED');
    expect(new URL(url, 'https://app.kilo.ai').searchParams.has('email')).toBe(false);
  });

  it('does not include email addresses on account-linking failure redirects', () => {
    const url = authFailureRedirectUrl('DIFFERENT-OAUTH', true);

    expect(url).toBe('/connected-accounts?error=DIFFERENT-OAUTH');
    expect(new URL(url, 'https://app.kilo.ai').searchParams.has('email')).toBe(false);
  });

  it('does not include email addresses on SSO enforcement redirects', () => {
    const url = ssoSignInRedirectUrl('example.com');

    expect(url).toBe('/users/sign_in?domain=example.com');
    expect(new URL(url, 'https://app.kilo.ai').searchParams.has('email')).toBe(false);
  });
});
