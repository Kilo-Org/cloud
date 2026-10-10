/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the component. */
// The sign-in landing keeps the email prompt but must offer the same OAuth
// provider group as sign-up, 'Continue with ChatGPT' included. The ChatGPT
// button is not decided from the visitor's address: it renders on the first
// screen, before the visitor takes the email step. The provider buttons and the
// email form are stubbed the way `SignInForm.test.ts` stubs them (their CSS
// module cannot load in jest), but the stubs render the real provider labels
// and the form's submit label.
import { jest } from '@jest/globals';
import { createElement, Fragment } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let mockFlowEmail = '';
let mockHintEmail = '';

jest.mock('@/components/AnimatedLogoMark', () => ({
  AnimatedLogoMark: () => null,
}));

jest.mock('@/hooks/useSignInFlow', () => ({
  useSignInFlow: ({ isSignUp }: { searchParams: Record<string, string>; isSignUp?: boolean }) => ({
    isHintLoaded: true,
    emailValidation: { isValid: true, error: null },
    error: '',
    showTurnstile: false,
    flowState: 'landing',
    tier: 'new',
    hint: mockHintEmail ? { lastEmail: mockHintEmail, lastAuthMethod: 'openai' } : null,
    showEmailInput: !isSignUp,
    email: mockFlowEmail,
    isVerifying: false,
    availableProviders: [],
    isNewUser: false,
    pendingSignIn: null,
    turnstileError: false,
    turnstileAttemptId: 0,
    inviteOrgId: undefined,
    inviteOrgName: undefined,
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

jest.mock('@/components/auth/sign-in/AuthProviderButtons', () => {
  const { getProviderById } = require('@/lib/auth/provider-metadata') as {
    getProviderById: (id: string) => { name: string; signInLabel?: string };
  };
  return {
    AuthProviderButtons: ({ providers }: { providers: string[] }) =>
      createElement(
        Fragment,
        null,
        ...providers.map(provider => {
          const meta = getProviderById(provider);
          return createElement(
            'button',
            { key: provider },
            meta.signInLabel ?? `Continue with ${meta.name}`
          );
        })
      ),
  };
});

jest.mock('@/components/auth/sign-in/EmailInputForm', () => ({
  EmailInputForm: ({ submitLabel }: { submitLabel?: string }) =>
    createElement('button', null, submitLabel ?? 'Continue'),
}));

const { SignInForm } = require('./SignInForm') as {
  SignInForm: (props: {
    searchParams: Record<string, string>;
    isSignUp?: boolean;
    title?: string;
  }) => ReactElement;
};

beforeEach(() => {
  mockFlowEmail = '';
  mockHintEmail = '';
});

describe('SignInForm sign-in options', () => {
  it('offers ChatGPT with the other OAuth providers before the email step', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, { searchParams: {}, title: 'Welcome.' })
    );

    // No address is known and the visitor has not submitted one, so the button
    // cannot come from the ChatGPT access flag: it is a plain sign-in option.
    expect(html.match(/Continue with ChatGPT/g)).toHaveLength(1);
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with Email');
    // It renders inside the provider group, in the shared provider order, so it
    // reads as one option beside the others rather than a lone button.
    expect(html.indexOf('Continue with Google')).toBeLessThan(
      html.indexOf('Continue with ChatGPT')
    );
  });

  it('offers ChatGPT on the first sign-up screen', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, {
        searchParams: {},
        isSignUp: true,
        title: 'Create your account',
      })
    );

    expect(html.match(/Continue with ChatGPT/g)).toHaveLength(1);
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with Email');
  });
});
