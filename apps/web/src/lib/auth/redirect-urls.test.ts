import {
  authFailureRedirectUrl,
  parseSignupStepUpMethodsParam,
  SIGNUP_STEP_UP_METHODS_PARAM,
  ssoSignInRedirectUrl,
} from '@/lib/auth/redirect-urls';

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

  it('carries the step-up methods to the sign-in page and back', () => {
    const url = authFailureRedirectUrl('SIGNUP-STEP-UP', false, ['google', 'apple']);
    const params = new URL(url, 'https://app.kilo.ai').searchParams;

    expect(params.get('error')).toBe('SIGNUP-STEP-UP');
    expect(
      parseSignupStepUpMethodsParam(params.get(SIGNUP_STEP_UP_METHODS_PARAM) ?? undefined)
    ).toEqual(['google', 'apple']);
    expect(authFailureRedirectUrl('SIGNUP-STEP-UP', false)).toBe(
      '/users/sign_in?error=SIGNUP-STEP-UP'
    );
  });

  it('keeps only known step-up methods from an untrusted query, in display order', () => {
    expect(parseSignupStepUpMethodsParam('apple,github,google,apple,passkey')).toEqual([
      'google',
      'apple',
    ]);
    expect(parseSignupStepUpMethodsParam('')).toEqual([]);
    expect(parseSignupStepUpMethodsParam(undefined)).toEqual([]);
  });
});
