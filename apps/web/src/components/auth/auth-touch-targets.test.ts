/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the components. */
// Apple's accessibility audit runs against the sign-in pages where the app
// opens them: in the in-app browser on a phone, where `pointer: coarse`
// matches. Its hit-region rule wants a 44pt target, so every control these
// pages render clears the bar either with the touch height (11 x Tailwind's
// 0.25rem spacing = 44px, the design system's `--control-size-touch`) or, for a
// link that runs inside a sentence, with coarse-pointer vertical padding that
// grows the link's own inline box without changing the line box.
//
// The audit calls each undersized element a hit-region issue, so this test
// counts the interactive elements a rendered surface leaves without the touch
// target rather than trusting one class on one component.
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceAuthClient as DeviceAuthClientType } from '@/app/device-auth/DeviceAuthClient';
import type {
  AuthProviderId,
  ProdNonSSOAuthProviders as ProdNonSSOAuthProvidersType,
} from '@/lib/auth/provider-metadata';
import type { AuthErrorNotification as AuthErrorNotificationType } from './AuthErrorNotification';
import type { MagicLinkSentConfirmation as MagicLinkSentConfirmationType } from './MagicLinkSentConfirmation';
import type { SignInForm as SignInFormType } from './SignInForm';
import type { SignInButton as SignInButtonType } from './SigninButton';
import type { AuthProviderButtons as AuthProviderButtonsType } from './sign-in/AuthProviderButtons';
import type { EmailInputForm as EmailInputFormType } from './sign-in/EmailInputForm';
import type { PasskeySignInButton as PasskeySignInButtonType } from './sign-in/PasskeySignInButton';
import type { TurnstileView as TurnstileViewType } from './sign-in/TurnstileView';

const mockFlow = {
  isHintLoaded: true,
  emailValidation: { isValid: true, error: null },
  error: '',
  showTurnstile: false,
  flowState: 'landing',
  tier: 'new',
  hint: null,
  showEmailInput: false,
  email: '',
  isVerifying: false,
  availableProviders: [] as AuthProviderId[],
  isNewUser: false,
  pendingSignIn: null,
  turnstileError: false,
  turnstileAttemptId: 0,
  inviteOrgId: undefined,
  inviteOrgName: undefined,
};

const mockPasskey = {
  isSupported: true,
  isPending: false,
  failure: null,
  signInWithPasskey: jest.fn(async () => {}),
};

jest.mock('@/components/AnimatedLogoMark', () => ({ AnimatedLogoMark: () => null }));

// A CSS module is not loadable in the jest node environment; the provider
// buttons are real, only their stylesheet name is stubbed.
jest.mock('./sign-in/AuthProviderButtons.module.css', () => ({ anacondaButton: 'anacondaButton' }));

jest.mock('@/hooks/useChatGptSignInAccess', () => ({
  useChatGptSignInAccess: () => false,
}));

jest.mock('@/hooks/usePasskeySignIn', () => ({ usePasskeySignIn: () => mockPasskey }));

jest.mock('next-auth/react', () => ({ signOut: jest.fn(async () => undefined) }));

jest.mock('react-turnstile', () => () => null);

jest.mock('@/hooks/useSignInFlow', () => ({
  useSignInFlow: () => ({
    ...mockFlow,
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

// The jest transform compiles JSX with the classic runtime
// (`React.createElement`), while the app compiles it with the automatic one, so
// a component that does not import React (Next.js does not need it to) looks up
// this global when the suite renders it. Every component below is required
// after this line for that reason.
(globalThis as { React?: unknown }).React = require('react');

const { SignInButton } = require('./SigninButton') as { SignInButton: typeof SignInButtonType };
const { AuthProviderButtons } = require('./sign-in/AuthProviderButtons') as {
  AuthProviderButtons: typeof AuthProviderButtonsType;
};
const { PasskeySignInButton } = require('./sign-in/PasskeySignInButton') as {
  PasskeySignInButton: typeof PasskeySignInButtonType;
};
const { EmailInputForm } = require('./sign-in/EmailInputForm') as {
  EmailInputForm: typeof EmailInputFormType;
};
const { TurnstileView } = require('./sign-in/TurnstileView') as {
  TurnstileView: typeof TurnstileViewType;
};
const { AuthErrorNotification } = require('./AuthErrorNotification') as {
  AuthErrorNotification: typeof AuthErrorNotificationType;
};
const { MagicLinkSentConfirmation } = require('./MagicLinkSentConfirmation') as {
  MagicLinkSentConfirmation: typeof MagicLinkSentConfirmationType;
};
const { SignInForm } = require('./SignInForm') as { SignInForm: typeof SignInFormType };
const { DeviceAuthClient } = require('@/app/device-auth/DeviceAuthClient') as {
  DeviceAuthClient: typeof DeviceAuthClientType;
};
const { ProdNonSSOAuthProviders } = require('@/lib/auth/provider-metadata') as {
  ProdNonSSOAuthProviders: typeof ProdNonSSOAuthProvidersType;
};

/**
 * The bar, in class names: a 44px minimum height, growing with a coarse
 * pointer. `min-h-11` is 11 x Tailwind's 0.25rem spacing and
 * `min-h-control-touch` reads the design system's 44px token directly.
 *
 * Both boundaries matter: without the leading one the pattern also matches
 * `max-h-11` (a cap, not a floor) or `sm:h-11` / `hover:h-11` (a non-coarse
 * variant), none of which guarantee a 44px target on a coarse pointer.
 */
const TOUCH_TARGET = /(?<![\w:-])(?:pointer-coarse:)?(?:min-)?h-(?:11|control-touch)(?![\w-])/;

/** Apple's hit-region minimum, in points. */
const HIT_REGION_MIN_PX = 44;

/** The smallest copy these surfaces set, `text-xs`, in px. */
const INLINE_TEXT_SIZE_PX = 12;

/**
 * The coarse-pointer vertical padding on the control, in px. A link that runs
 * inside a sentence cannot reserve the touch height without pushing its line
 * apart, so it grows its own inline box instead: `pointer-coarse:py-4` is 16px
 * a side, which puts the `text-xs` content box at 2 x 16 + 12 = 44px.
 */
function inlineTouchPaddingPx(tag: string): number {
  const padding = tag.match(/pointer-coarse:py-(\d+(?:\.\d+)?)(?![\w.-])/);
  // Tailwind's spacing unit is 0.25rem = 4px.
  return padding ? Number(padding[1]) * 4 : 0;
}

function hasTouchTarget(tag: string): boolean {
  if (TOUCH_TARGET.test(tag)) return true;
  return inlineTouchPaddingPx(tag) * 2 + INLINE_TEXT_SIZE_PX >= HIT_REGION_MIN_PX;
}

function interactiveTags(html: string): string[] {
  return html.match(/<(?:button|a|input)\b[^>]*>/g) ?? [];
}

function controlsWithoutTouchTarget(html: string): string[] {
  return interactiveTags(html).filter(tag => !hasTouchTarget(tag));
}

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  return renderToStaticMarkup(node);
}

beforeEach(() => {
  mockFlow.showEmailInput = false;
  mockFlow.tier = 'new';
  mockFlow.isHintLoaded = true;
  mockFlow.flowState = 'landing';
  mockFlow.availableProviders = [];
  mockFlow.error = '';
});

describe('sign-in touch targets', () => {
  // 11 x 0.25rem = 2.75rem = 44px only while the root stays at the browser
  // default, and the class must name the same bar as the design system token.
  it('targets the 44px touch control size Apple audits against', () => {
    const globals = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');

    expect(globals).toContain('--control-size-touch: 44px');
    // Every px assertion in this suite reads `min-h-11` as 11 x 0.25rem and
    // the root at the browser default, so a root font size (via `font-size`
    // or the `font:` shorthand) or a `--spacing` override would silently
    // invalidate the 44px math while the suite stayed green.
    expect(globals).not.toMatch(/(?:html|:root)\s*\{[^}]*\bfont(?:-size)?\s*:/);
    expect(globals).not.toMatch(/(?:^|[\s;{])--spacing\s*:/m);
  });

  it('reads the touch target only from a standalone class', () => {
    for (const accepted of [
      'pointer-coarse:min-h-11',
      'min-h-11',
      'min-h-control-touch',
      'pointer-coarse:min-h-control-touch',
      'px-4 pointer-coarse:min-h-11',
    ]) {
      expect({ accepted, ok: hasTouchTarget(`<button class="${accepted}">`) }).toEqual({
        accepted,
        ok: true,
      });
    }

    // `max-h-11` caps instead of flooring, and a non-coarse variant does not
    // guarantee the height on the coarse pointer Apple audits.
    for (const rejected of ['max-h-11', 'sm:h-11', 'hover:h-11', 'h-10']) {
      expect({ rejected, ok: hasTouchTarget(`<button class="${rejected}">`) }).toEqual({
        rejected,
        ok: false,
      });
    }
  });

  it('grows the provider button to the touch target on a coarse pointer', () => {
    const html = render(createElement(SignInButton, null, 'Continue with GitHub'));

    expect(html).toContain('pointer-coarse:min-h-11');
  });

  it('covers every provider button the sign-in pages render', () => {
    const html = render(
      createElement(AuthProviderButtons, {
        providers: ProdNonSSOAuthProviders,
        onProviderClick: () => undefined,
      })
    );

    expect(prodButtonCount(html)).toBe(ProdNonSSOAuthProviders.length);
    expect(controlsWithoutTouchTarget(html)).toEqual([]);
  });

  // `isSignUp` omitted means the normal sign-in landing: the email input with
  // the provider buttons offered beside it, not the provider-only view (that
  // one is the sign-up test below).
  it('leaves no control under the touch target on the default sign-in view', () => {
    const html = render(createElement(SignInForm, { searchParams: {}, title: 'Welcome.' }));

    expect(html).toContain('Continue with Email');
    expect(controlsWithoutTouchTarget(html)).toEqual([]);
  });

  it('leaves no control under the touch target on the email view', () => {
    mockFlow.showEmailInput = true;
    const html = render(createElement(SignInForm, { searchParams: {}, title: 'Welcome.' }));

    expect(html).toContain('Email address');
    expect(controlsWithoutTouchTarget(html)).toEqual([]);
  });

  it('leaves no control under the touch target on the sign-up view', () => {
    const html = render(
      createElement(SignInForm, { searchParams: {}, title: 'Welcome.', isSignUp: true })
    );

    expect(html).toContain('Already have an account?');
    expect(controlsWithoutTouchTarget(html)).toEqual([]);
  });

  it('leaves no control under the touch target on the provider-select view', () => {
    mockFlow.flowState = 'provider-select';
    mockFlow.email = 'ada@kilo.ai';
    mockFlow.availableProviders = [...ProdNonSSOAuthProviders];
    const html = render(createElement(SignInForm, { searchParams: {}, title: 'Welcome.' }));

    expect(html).toContain('Email me a magic link');
    expect(controlsWithoutTouchTarget(html)).toEqual([]);
  });

  it('leaves no control under the touch target on the error view', () => {
    mockFlow.error = 'LINKING-FAILED';
    const html = render(createElement(SignInForm, { searchParams: {}, title: 'Welcome.' }));

    expect(html).toContain('Account Linking Failed');
    expect(controlsWithoutTouchTarget(html)).toEqual([]);
  });

  it('leaves no control under the touch target when the error carries support links', () => {
    mockFlow.error = 'SIGNUP-RATE-LIMITED';
    const html = render(createElement(SignInForm, { searchParams: {}, title: 'Welcome.' }));

    expect(html).toContain('contact support');
    expect(controlsWithoutTouchTarget(html)).toEqual([]);
  });

  it('leaves no control under the touch target on the blocked view', () => {
    mockFlow.error = 'BLOCKED';
    const html = render(createElement(SignInForm, { searchParams: {}, title: 'Welcome.' }));

    expect(html).toContain('Account Blocked');
    expect(controlsWithoutTouchTarget(html)).toEqual([]);
  });

  it('clears the touch bar on every error notification the page can show', () => {
    const errors = [
      'BLOCKED',
      'DIFFERENT-OAUTH',
      'DISCOVERY_RATE_LIMITED',
      'DISCOVERY_FAILED',
      'NO_SUPPORTED_SIGN_IN_METHOD',
      'MAGIC_LINK_DELIVERY_FAILED',
      'ACCOUNT-ALREADY-LINKED',
      'PROVIDER-ALREADY-LINKED',
      'LINKING-FAILED',
      'SIGNUP-RATE-LIMITED',
      'EMAIL-ALREADY-USED',
      'EMAIL-MUST-BE-LOWERCASE',
      'EMAIL-CANNOT-CONTAIN-PLUS',
      'untrusted-query-error',
    ];

    for (const error of errors) {
      const html = render(createElement(AuthErrorNotification, { error }));
      expect({ error, controls: controlsWithoutTouchTarget(html) }).toEqual({
        error,
        controls: [],
      });
    }
  });

  it('lifts the in-sentence links with padding that keeps the line box intact', () => {
    const html = render(createElement(SignInForm, { searchParams: {}, title: 'Welcome.' }));
    const terms = html.match(/<a[^>]*kilo\.ai\/terms[^>]*>/)?.[0] ?? '';

    expect(terms).not.toBe('');
    // Vertical padding on an inline box grows the link's hit region without
    // changing the line box; `inline-block`/`min-h` would move the sentence's
    // lines apart.
    expect(terms).not.toContain('inline-block');
    expect(inlineTouchPaddingPx(terms) * 2 + INLINE_TEXT_SIZE_PX).toBeGreaterThanOrEqual(
      HIT_REGION_MIN_PX
    );
  });

  it('leaves no control under the touch target on the device-code page', () => {
    const html = render(
      createElement(DeviceAuthClient, {
        code: 'ABCD-1234',
        viewerToken: 'viewer-token',
        isAppMode: true,
        user: { name: 'Ada Lovelace', email: 'ada@kilo.ai', imageUrl: '' },
      })
    );

    expect(html).toContain('Authorize');
    expect(controlsWithoutTouchTarget(html)).toHaveLength(0);
  });

  it('leaves no control under the touch target on the magic-link confirmation', () => {
    const html = render(
      createElement(MagicLinkSentConfirmation, { email: 'ada@kilo.ai', onBack: () => undefined })
    );

    expect(html).toContain('← Back to sign in');
    expect(controlsWithoutTouchTarget(html)).toHaveLength(0);
  });

  it('leaves no control under the touch target on the passkey control', () => {
    const html = render(createElement(PasskeySignInButton, { callbackUrl: '/welcome' }));

    expect(html).toContain('Sign in with a passkey');
    expect(controlsWithoutTouchTarget(html)).toHaveLength(0);
  });

  it('leaves no control under the touch target on the verification view', () => {
    const html = render(
      createElement(TurnstileView, {
        turnstileError: true,
        isVerifying: false,
        attemptId: 0,
        onSuccess: () => undefined,
        onError: () => undefined,
        onRetry: () => undefined,
        onBack: () => undefined,
        backButtonText: 'sign in options',
      })
    );

    expect(html).toContain('Try Again');
    expect(controlsWithoutTouchTarget(html)).toHaveLength(0);
  });

  it('leaves no control under the touch target on the email form', () => {
    const html = render(
      createElement(EmailInputForm, {
        email: 'ada@kilo.ai',
        emailValidation: { isValid: true, error: null },
        onSubmit: () => undefined,
        onEmailChange: () => undefined,
      })
    );

    expect(controlsWithoutTouchTarget(html)).toHaveLength(0);
  });
});

/** Provider buttons carrying the touch target, in whichever spelling. */
function prodButtonCount(html: string): number {
  return interactiveTags(html).filter(hasTouchTarget).length;
}
