/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the component. */
// The sign-in landing keeps the email prompt but must also offer the OAuth
// providers (including 'Continue with ChatGPT'), the same group the sign-up page
// renders. The ChatGPT option is behind the PostHog flag, which for a
// signed-out visitor is evaluated against the email the visitor typed; the hook
// is stubbed here and the filter is asserted. The provider buttons and the
// email form are stubbed the way `SignInForm.test.ts` stubs them (their CSS
// module cannot load in jest), but the stubs render the real provider labels
// and the form's submit label.
import { jest } from '@jest/globals';
import { createElement, Fragment } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let mockFlowEmail = '';
let mockHintEmail = '';
let mockChatGptAllowed = false;
let mockHookEmail: string | null = null;

jest.mock('@/components/AnimatedLogoMark', () => ({
  AnimatedLogoMark: () => null,
}));

jest.mock('@/hooks/useChatGptSignInAccess', () => ({
  useChatGptSignInAccess: (email: string | null) => {
    mockHookEmail = email;
    return mockChatGptAllowed;
  },
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
  mockChatGptAllowed = false;
  mockHookEmail = null;
});

describe('SignInForm sign-in options', () => {
  it('hides ChatGPT on sign-in when the flag is off for the submitted email', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, { searchParams: {}, title: 'Welcome.' })
    );

    expect(html).not.toContain('Continue with ChatGPT');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with Email');
    // Nothing is known before a submit, so the hook gets no address.
    expect(mockHookEmail).toBe(null);
  });

  it('offers ChatGPT on sign-in when the flag is on for the submitted email', () => {
    mockFlowEmail = 'person@kilo.ai';
    mockChatGptAllowed = true;
    const html = renderToStaticMarkup(
      createElement(SignInForm, { searchParams: {}, title: 'Welcome.' })
    );

    expect(html.match(/Continue with ChatGPT/g)).toHaveLength(1);
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with Email');
    // Typing alone is not evaluated; the hook waits for the submit.
    expect(mockHookEmail).toBe(null);
  });

  it('evaluates a prefilled ?email= address before the providers render', () => {
    mockChatGptAllowed = true;
    renderToStaticMarkup(
      createElement(SignInForm, {
        searchParams: { email: 'prefill@kilo.ai' },
        title: 'Welcome.',
      })
    );

    expect(mockHookEmail).toBe('prefill@kilo.ai');
  });

  it('evaluates a stored returning-user address', () => {
    mockFlowEmail = 'returning@kilo.ai';
    mockHintEmail = 'returning@kilo.ai';
    mockChatGptAllowed = true;
    renderToStaticMarkup(createElement(SignInForm, { searchParams: {}, title: 'Welcome.' }));

    expect(mockHookEmail).toBe('returning@kilo.ai');
  });

  it('evaluates the query prefill over a stored returning-user address', () => {
    mockFlowEmail = 'prefill@kilo.ai';
    mockHintEmail = 'hint@kilo.ai';
    mockChatGptAllowed = true;
    renderToStaticMarkup(
      createElement(SignInForm, {
        searchParams: { email: 'prefill@kilo.ai' },
        title: 'Welcome.',
      })
    );

    expect(mockHookEmail).toBe('prefill@kilo.ai');
  });

  it('hides ChatGPT on sign-up when the flag is off for the typed email', () => {
    const html = renderToStaticMarkup(
      createElement(SignInForm, { searchParams: {}, isSignUp: true, title: 'Create your account' })
    );

    expect(html).not.toContain('Continue with ChatGPT');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with Email');
  });

  it('offers ChatGPT on sign-up when the flag is on for the typed email', () => {
    mockFlowEmail = 'person@openai.com';
    mockChatGptAllowed = true;
    const html = renderToStaticMarkup(
      createElement(SignInForm, { searchParams: {}, isSignUp: true, title: 'Create your account' })
    );

    expect(html.match(/Continue with ChatGPT/g)).toHaveLength(1);
  });
});
