/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the component. */
import { jest } from '@jest/globals';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('@/components/auth/sign-in/AuthProviderButtons', () => ({
  AuthProviderButtons: () => null,
}));

jest.mock('@/components/AnimatedLogoMark', () => ({
  AnimatedLogoMark: () => null,
}));

jest.mock('@/components/auth/sign-in/EmailInputForm', () => ({
  EmailInputForm: () => null,
}));

jest.mock('@/components/auth/sign-in/PasskeySignInButton', () => ({
  PasskeySignInButton: ({ callbackUrl }: { callbackUrl?: string }) =>
    createElement(
      'button',
      { 'data-testid': 'passkey-signin', 'data-callback-url': callbackUrl },
      'Sign in with a passkey'
    ),
}));

jest.mock('@/hooks/useSignInFlow', () => ({
  useSignInFlow: ({
    searchParams,
    error,
    isSignUp,
    ssoMode,
  }: {
    searchParams: Record<string, string>;
    error?: string;
    isSignUp?: boolean;
    ssoMode?: boolean;
  }) => {
    // `__tier` lets a test reach the returning-user block, which the real hook
    // only produces once the localStorage hint has loaded.
    const returning = searchParams.__tier === 'returning';
    return {
      isHintLoaded: true,
      emailValidation: { isValid: !error, error: null },
      error: error ?? '',
      showTurnstile: false,
      flowState: 'landing',
      tier: returning
        ? 'returning'
        : ssoMode
          ? 'new'
          : searchParams.org && searchParams.email
            ? 'invite'
            : 'new',
      hint: returning
        ? {
            lastEmail: searchParams.email,
            lastAuthMethod: searchParams.provider ?? 'google',
            orgId: searchParams.provider === 'workos' ? 'org-1' : undefined,
            lastLogin: '2026-01-01T00:00:00.000Z',
          }
        : null,
      showEmailInput: returning ? false : Boolean(ssoMode) || !isSignUp,
      email: '',
      isVerifying: false,
      availableProviders: [],
      isNewUser: false,
      pendingSignIn: null,
      turnstileError: false,
      turnstileAttemptId: 0,
      inviteOrgId: searchParams.org,
      inviteOrgName: searchParams.org,
      handleEmailSubmit: jest.fn(),
      handleEmailChange: jest.fn(),
      handleBack: jest.fn(),
      handleProviderSelect: jest.fn(),
      handleOAuthClick: jest.fn(),
      handleClearHint: jest.fn(),
      handleSSOContinue: jest.fn(),
      handleClearInvite: jest.fn(),
      handleTurnstileSuccess: jest.fn(),
      handleTurnstileError: jest.fn(),
      handleRetryTurnstile: jest.fn(),
      handleShowEmailInput: jest.fn(),
    };
  },
}));

const { SignInForm } = require('./SignInForm') as {
  SignInForm: (props: {
    error?: string;
    isSignUp?: boolean;
    ssoMode?: boolean;
    emailOnly?: boolean;
    title?: string;
    searchParams: Record<string, string>;
  }) => ReactElement;
};

describe('SignInForm Enterprise SSO navigation', () => {
  it('renders the neutral normal sign-in title with one install action', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        searchParams: {},
        title: 'Welcome.',
      })
    );

    expect(html).toContain('Welcome.');
    expect(html.match(/Install Kilo Code/g)).toHaveLength(1);
    expect(html).toContain('Enterprise SSO');
  });

  it('renders SSO Back as normal sign-in while retaining approved context', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        ssoMode: true,
        searchParams: {
          sso: 'true',
          domain: 'example.com',
          signup: 'true',
          error: 'OAuthCallback',
          email: 'user@example.com',
          org: 'org-123',
          callbackPath: '/claw/new',
          source: 'extension',
          utm_campaign: 'launch',
        },
      })
    );

    expect(html).toContain(
      'href="/users/sign_in?source=extension&amp;utm_campaign=launch&amp;callbackPath=%2Fclaw%2Fnew"'
    );
    expect(html).toContain('← Back to sign in options');
    expect(html).not.toContain('sso=true');
    expect(html).not.toContain('domain=example.com');
  });

  it('keeps a prefilled explicit sign-up provider-first', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        isSignUp: true,
        searchParams: { signup: 'true', email: 'new@example.com' },
      })
    );

    expect(html).toContain('Continue with Email');
    expect(html).not.toContain('Security Verification');
    expect(html).not.toContain('Install Kilo Code');
  });

  it('renders an invite SSO CTA instead of automatic discovery', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        searchParams: { email: 'invited@example.com', org: 'org-1' },
      })
    );

    expect(html).toContain('Continue to Single Sign-On');
    expect(html).not.toContain('Security Verification');
    expect(html.match(/Install Kilo Code/g)).toHaveLength(1);
  });

  it('renders callback errors globally when the empty email is invalid', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        searchParams: {},
        error: 'LINKING-FAILED',
      })
    );

    expect(html).toContain('data-error-notification');
    expect(html).toContain('Account Linking Failed');
  });
});

describe('SignInForm passkey sign-in placement', () => {
  it('offers the passkey above the OAuth providers on explicit sign-up', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        isSignUp: true,
        searchParams: { signup: 'true' },
      })
    );

    expect(html).toContain('data-testid="passkey-signin"');
    expect(html).toContain('data-callback-url="/users/after-sign-in?signup=true"');
    // Above the other providers, and none of them are removed or relabelled.
    expect(html.indexOf('data-testid="passkey-signin"')).toBeLessThan(
      html.indexOf('Continue with Email')
    );
  });

  it('offers the passkey beside the remembered provider for a returning user', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        searchParams: { __tier: 'returning', provider: 'google', email: 'back@example.com' },
      })
    );

    expect(html).toContain('data-testid="passkey-signin"');
    expect(html).toContain('or see other sign-in methods');
  });

  it('offers the passkey beside Enterprise SSO for a returning SSO user', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        searchParams: { __tier: 'returning', provider: 'workos', email: 'back@example.com' },
      })
    );

    expect(html).toContain('Sign in with Enterprise SSO');
    expect(html).toContain('data-testid="passkey-signin"');
  });

  it('never offers the passkey in SSO mode or email-only mode', () => {
    const propSets: {
      ssoMode?: boolean;
      emailOnly?: boolean;
      searchParams: Record<string, string>;
    }[] = [
      { ssoMode: true, searchParams: { sso: 'true' } },
      { emailOnly: true, searchParams: { domain: 'example.com' } },
    ];
    for (const props of propSets) {
      const html = renderToStaticMarkup(createElement(SignInForm, props));
      expect(html).not.toContain('data-testid="passkey-signin"');
    }
  });

  it('keeps the passkey out of the email-first sign-in view', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, { searchParams: { email: 'first@example.com' } })
    );

    expect(html).not.toContain('data-testid="passkey-signin"');
    expect(html.match(/Install Kilo Code/g)).toHaveLength(1);
  });
});
