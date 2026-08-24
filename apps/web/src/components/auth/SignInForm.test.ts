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

jest.mock('@/hooks/useSignInFlow', () => ({
  useSignInFlow: ({
    searchParams,
    isSignUp,
    ssoMode,
  }: {
    searchParams: Record<string, string>;
    isSignUp?: boolean;
    ssoMode?: boolean;
  }) => ({
    isHintLoaded: true,
    emailValidation: { isValid: true, error: null },
    error: '',
    showTurnstile: false,
    flowState: 'landing',
    tier: ssoMode ? 'new' : searchParams.org && searchParams.email ? 'invite' : 'new',
    hint: null,
    showEmailInput: Boolean(ssoMode) || !isSignUp,
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
  }),
}));

const { SignInForm } = require('./SignInForm') as {
  SignInForm: (props: {
    isSignUp?: boolean;
    ssoMode?: boolean;
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
});
