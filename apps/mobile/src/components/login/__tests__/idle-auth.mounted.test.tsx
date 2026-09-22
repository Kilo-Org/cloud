/* eslint-disable max-lines -- the suite owns the sign-in hierarchy contract and the inline-link touch-target audit for one screen, and the SSO-recovery, passkey, legal-link, and email-validation suites share one native-auth mock harness; splitting them would duplicate every mock in this file */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openBrowserAsync } from 'expo-web-browser';
import { AppleAuthenticationButtonStyle } from 'expo-apple-authentication';
import {
  INLINE_LINK_CONNECTOR_CLASS,
  MIN_TAP_TARGET_DP,
  TOUCH_TARGET_DP,
} from '@/lib/a11y/tap-target';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config';
import { i18n } from '@/i18n';

import { IdleAuth } from '../idle-auth';

type StartFn = (mode: 'signin' | 'sso', ssoEmail?: string) => Promise<void>;

type SsoRecoveryFixture = { email: string; ssoOrganizationId: string | undefined } | null;

const ssoRecovery: { value: SsoRecoveryFixture } = vi.hoisted(() => ({
  value: { email: 'user@example.com', ssoOrganizationId: 'org_1' },
}));

// The native passkey module is absent in the test runtime, so the capability is
// the one input the screen reads from the client module.
const passkeySupport = vi.hoisted(() => ({ supported: true }));

// Which provider controls the screen renders: Apple availability and the
// Google client ID both come from outside the component.
const providers = vi.hoisted(() => ({ appleAvailable: false, googleConfigured: false }));

// What the screen reads from the hook: a fixed result object plus the one piece
// of state the busy treatment depends on.
const nativeAuth = vi.hoisted(() => ({
  busy: undefined as 'otp-send' | 'passkey' | undefined,
  emailError: undefined as string | undefined,
  clearEmailError: vi.fn(),
  requestEmailCode: vi.fn(),
  signInWithPasskey: vi.fn(),
}));

vi.mock('@/lib/auth/passkey-client', () => ({
  passkeysSupported: () => passkeySupport.supported,
}));

vi.mock('@/lib/auth/use-native-auth', () => ({
  useNativeAuth: () => ({
    busy: nativeAuth.busy,
    emailError: nativeAuth.emailError,
    clearEmailError: nativeAuth.clearEmailError,
    googleConfigured: providers.googleConfigured,
    signInWithApple: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithPasskey: nativeAuth.signInWithPasskey,
    requestEmailCode: nativeAuth.requestEmailCode,
    verifyEmailCode: vi.fn(),
    ssoRecovery: ssoRecovery.value,
    clearSsoRecovery: vi.fn(),
    handleSsoError: vi.fn(),
  }),
}));

vi.mock('@/lib/login-draft', () => ({
  setLoginEmailDraft: vi.fn(),
  setSsoRecoveryDraft: vi.fn(),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: 'AppleAuthenticationButton',
  AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  isAvailableAsync: vi.fn(async () => {
    await Promise.resolve();
    return providers.appleAvailable;
  }),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  View: 'View',
}));

vi.mock('sonner-native', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/login/email-otp-form', () => ({ EmailOtpForm: 'EmailOtpForm' }));
vi.mock('@/components/login/google-logo', () => ({ GoogleLogo: 'GoogleLogo' }));

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  TERMS_URL: 'https://app.kilo.ai/terms-app',
  PRIVACY_URL: 'https://app.kilo.ai/privacy-app',
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;
const renderers: R[] = [];

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
});

async function mountIdleAuth(start: StartFn): Promise<R> {
  const ref: { current: R | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(IdleAuth, { start }));
    await Promise.resolve();
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  renderers.push(r);
  return r;
}

function texts(root: I): string[] {
  return root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        typeof n.props.children === 'string'
    )
    .map(n => n.props.children as string);
}

function findButton(root: I, label: string): I {
  const buttons = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Button');
  const btn = buttons.find(b => (b.props.accessibilityLabel as string) === label);
  if (!btn) {
    throw new Error(`button "${label}" not found`);
  }
  return btn;
}

function linkPressables(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      n.props.accessibilityRole === 'link'
  );
}

function findLink(root: I, label: string): I {
  const links = linkPressables(root).filter(link => link.props.accessibilityLabel === label);
  const link = links[0];
  if (!link || links.length !== 1) {
    throw new Error(`link "${label}" found ${links.length} times, expected once`);
  }
  return link;
}

/** The box a control's className declares, in dp: its own height and width. */
function boxDp(className: string): { width: number; height: number } {
  const size = (axis: 'h' | 'w'): number => {
    const pattern = new RegExp(`^(?:min-)?${axis}-\\[(\\d+(?:\\.\\d+)?)px\\]$`);
    for (const part of className.split(/\s+/)) {
      const match = pattern.exec(part);
      if (match?.[1]) {
        return Number(match[1]);
      }
    }
    throw new Error(`no ${axis} size class in "${className}"`);
  };
  return { width: size('w'), height: size('h') };
}

/** The smallest per-side reach a hitSlop expresses, in dp. */
function slopDp(hitSlop: unknown): number {
  if (typeof hitSlop === 'number') {
    return hitSlop;
  }
  if (hitSlop && typeof hitSlop === 'object') {
    const sides = Object.values(hitSlop as Record<string, number | undefined>);
    return Math.min(...sides.map(side => side ?? 0));
  }
  return 0;
}

function findAppleButton(root: I): I {
  const nodes = root.findAll(
    n => typeof n.type === 'string' && (n.type as string) === 'AppleAuthenticationButton'
  );
  const node = nodes[0];
  if (!node) {
    throw new Error('Apple sign-in button not found');
  }
  return node;
}

/** A Button that keeps the default (brand-filled) variant is a primary action. */
function filledPrimaryLabels(root: I): (string | undefined)[] {
  return root
    .findAll(n => typeof n.type === 'string' && (n.type as string) === 'Button')
    .filter(b => b.props.variant === undefined)
    .map(b => b.props.accessibilityLabel as string | undefined);
}

// Provider controls are opt-in per test; the file default is the plain
// email-only form every other suite renders.
beforeEach(() => {
  providers.appleAvailable = false;
  providers.googleConfigured = false;
});

describe('IdleAuth sign-in hierarchy', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    nativeAuth.busy = undefined;
    passkeySupport.supported = true;
    providers.appleAvailable = true;
    providers.googleConfigured = true;
  });

  it('leaves the email Continue as the only filled primary action', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    // Every provider control is a secondary: Apple wears the outlined native
    // style, Google and the passkey are outline Buttons.
    expect(findAppleButton(renderer.root).props.buttonStyle).toBe(
      AppleAuthenticationButtonStyle.WHITE_OUTLINE
    );
    expect(findButton(renderer.root, 'Sign in with Google').props.variant).toBe('outline');
    expect(findButton(renderer.root, 'Sign in with a passkey').props.variant).toBe('outline');

    expect(filledPrimaryLabels(renderer.root)).toEqual(['Continue with email']);

    act(() => {
      renderer.unmount();
    });
  });

  it('never falls back to a solid Apple button style', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const style = findAppleButton(renderer.root).props.buttonStyle;
    expect(style).not.toBe(AppleAuthenticationButtonStyle.BLACK);
    expect(style).not.toBe(AppleAuthenticationButtonStyle.WHITE);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps one filled primary action without Apple sign-in', async () => {
    providers.appleAvailable = false;
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    expect(() => findAppleButton(renderer.root)).toThrow('Apple sign-in button not found');
    expect(filledPrimaryLabels(renderer.root)).toEqual(['Continue with email']);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('IdleAuth SSO recovery', () => {
  beforeEach(() => {
    ssoRecovery.value = { email: 'user@example.com', ssoOrganizationId: 'org_1' };
    nativeAuth.busy = undefined;
    passkeySupport.supported = true;
  });

  it('shows the recovery copy and forwards the SSO start', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    expect(texts(renderer.root)).toContain('Your organization uses single sign-on.');

    const btn = findButton(renderer.root, 'Continue with SSO');
    await act(async () => {
      await Promise.resolve();
      (btn.props.onPress as () => void)();
    });

    expect(start).toHaveBeenCalledWith('sso', 'user@example.com');
  });
});

describe('IdleAuth passkey control', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    passkeySupport.supported = true;
    nativeAuth.busy = undefined;
    nativeAuth.signInWithPasskey.mockClear();
  });

  it('offers the passkey button above the email field', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const btn = findButton(renderer.root, 'Sign in with a passkey');
    expect(btn.props.variant).toBe('outline');
    expect(btn.props.size).toBe('lg');

    const order = renderer.root
      .findAll(n => typeof n.type === 'string' && ['Button', 'FormField'].includes(n.type))
      .map(n => n.props.accessibilityLabel ?? n.props.label);

    expect(order).toEqual([
      'Sign in with a passkey',
      'Email address',
      'Continue with email',
      'More sign-in options',
    ]);
  });

  it('starts the passkey ceremony on press', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const btn = findButton(renderer.root, 'Sign in with a passkey');
    act(() => {
      (btn.props.onPress as () => void)();
    });

    expect(nativeAuth.signInWithPasskey).toHaveBeenCalledTimes(1);
  });

  it('shows the busy treatment while the ceremony runs', async () => {
    nativeAuth.busy = 'passkey';
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const btn = findButton(renderer.root, 'Sign in with a passkey');
    expect(btn.props.disabled).toBe(true);
    expect(
      btn.findAll(n => typeof n.type === 'string' && (n.type as string) === 'ActivityIndicator')
    ).toHaveLength(1);
    expect(btn.parent?.props.pointerEvents).toBe('none');
  });

  it('renders no passkey control without the native module', async () => {
    passkeySupport.supported = false;
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    expect(() => findButton(renderer.root, 'Sign in with a passkey')).toThrow(
      'button "Sign in with a passkey" not found'
    );
    expect(texts(renderer.root)).not.toContain('Sign in with a passkey');
    // The other ways in are untouched.
    expect(findButton(renderer.root, 'Continue with email')).toBeTruthy();
  });

  // The reported capture: the Arabic passkey label ("تسجيل الدخول بمفتاح
  // المرور") wrapped onto two lines and made the passkey button visibly taller
  // than the single-line Google button directly above it. Both provider labels
  // are pinned to one line so the stack keeps one row height.
  it.each(['ar', 'en'])('keeps both provider labels on one line in %s', async language => {
    providers.googleConfigured = true;
    passkeySupport.supported = true;
    await i18n.changeLanguage(language);

    const renderer = await mountIdleAuth(vi.fn<StartFn>());
    const copies = [i18n.t('login.signInWithGoogle'), i18n.t('login.signInWithPasskey')];

    for (const copy of copies) {
      const text = renderer.root.find(
        n =>
          typeof n.type === 'string' && (n.type as string) === 'Text' && n.props.children === copy
      );
      expect(text.props.numberOfLines).toBe(1);
      expect(text.props.adjustsFontSizeToFit).toBe(true);
      const button = renderer.root.findByProps({ accessibilityLabel: copy });
      // The row itself must not wrap either: a wrapping row moves the pinned
      // label onto a second line and grows the button again.
      expect(button.props.className).not.toContain('flex-wrap');
      // The full label stays the control's accessible name.
      expect(button.props.accessibilityLabel).toBe(copy);
    }

    await i18n.changeLanguage('en');
  });
});
describe('IdleAuth email continue copy', () => {
  it('shows a Continue button with email accessibility', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    expect(texts(renderer.root)).toContain('Continue');
    expect(texts(renderer.root)).not.toContain('Sign in or create an account');

    const btn = findButton(renderer.root, 'Continue with email');
    expect(btn).toBeTruthy();
  });

  it('shows the Terms and Privacy Policy line', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    expect(texts(renderer.root)).toContain('Terms');
    expect(texts(renderer.root)).toContain('Privacy Policy');
  });

  it('offers each legal link as its own pressable target on the audit floor', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    const links = linkPressables(renderer.root);
    expect(links.map(link => link.props.accessibilityLabel)).toEqual(['Terms', 'Privacy Policy']);

    for (const link of links) {
      const box = boxDp(link.props.className as string);
      expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
      expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
      const slop = slopDp(link.props.hitSlop);
      expect(box.width + 2 * slop).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
      expect(box.height + 2 * slop).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    }

    // The sentence's copy is unchanged: both labels still render, with the
    // connector and suffix the sentence carried before.
    expect(texts(renderer.root)).toEqual(
      expect.arrayContaining(['Terms', 'Privacy Policy', ' and ', '.'])
    );

    act(() => {
      renderer.unmount();
    });
  });

  it('routes the sentence connector through the shared inline-link gap', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    // The connector text is the only node between the two links, so it carries
    // the shared gap class that keeps their facing slops off each other in a
    // catalog with a short conjunction (ru " и ", pl " i ", ar " و ",
    // zh " 和 "). `tap-target.test.ts` compiles the class's width.
    const connectors = renderer.root.findAll(
      n =>
        typeof n.type === 'string' && (n.type as string) === 'Text' && n.props.children === ' and '
    );
    expect(connectors).toHaveLength(1);
    expect(connectors[0]?.props.className).toContain(INLINE_LINK_CONNECTOR_CLASS);

    act(() => {
      renderer.unmount();
    });
  });

  it('opens the browser for Terms and Privacy Policy', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    const terms = findLink(renderer.root, 'Terms');
    act(() => {
      (terms.props.onPress as () => void)();
    });
    expect(openBrowserAsync).toHaveBeenCalledWith(TERMS_URL);

    const privacy = findLink(renderer.root, 'Privacy Policy');
    act(() => {
      (privacy.props.onPress as () => void)();
    });
    expect(openBrowserAsync).toHaveBeenCalledWith(PRIVACY_URL);
  });
});

describe('IdleAuth email validation layout', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    nativeAuth.busy = undefined;
    nativeAuth.emailError = undefined;
    nativeAuth.clearEmailError.mockClear();
    nativeAuth.requestEmailCode.mockReset();
  });

  it('keeps validation in the field before an enabled Continue, then accepts a correction', async () => {
    nativeAuth.emailError = 'Check your email address and try again.';
    const renderer = await mountIdleAuth(vi.fn<StartFn>());
    const field = renderer.root.findByType('FormField');
    expect(field.props.error).toBe(nativeAuth.emailError);
    expect(field.props.reserveErrorMessages).toEqual([
      'Please enter your email address.',
      nativeAuth.emailError,
      'Unable to deliver email to this address. Please use a different email.',
    ]);
    const button = findButton(renderer.root, 'Continue with email');
    expect(button.props.disabled).toBe(false);
    const siblings = field.parent?.children;
    expect(siblings?.indexOf(field)).toBeLessThan(siblings?.indexOf(button) ?? 0);
    act(() => {
      (field.props.onChangeText as (value: string) => void)('user@example.com');
    });
    expect(nativeAuth.clearEmailError).toHaveBeenCalledOnce();
    nativeAuth.emailError = undefined;
    nativeAuth.requestEmailCode.mockResolvedValue(true);
    await act(async () => {
      await (button.props.onPress as () => Promise<void>)();
    });
    expect(nativeAuth.requestEmailCode).toHaveBeenCalledWith('user@example.com');
    expect(renderer.root.findByType('EmailOtpForm').props.email).toBe('user@example.com');
    nativeAuth.requestEmailCode.mockResolvedValue(false);
    await act(async () => {
      (renderer.root.findByType('EmailOtpForm').props.onResend as () => void)();
      nativeAuth.emailError =
        'Unable to deliver email to this address. Please use a different email.';
      renderer.update(createElement(IdleAuth, { start: vi.fn<StartFn>() }));
      await Promise.resolve();
    });
    const remounted = renderer.root.findByType('FormField');
    expect(remounted.props.error).toBe(nativeAuth.emailError);
    // The field remounted when the view returned from OTP: it must show the
    // rejected address, not blank out while `emailRef` still holds it.
    expect(remounted.props.defaultValue).toBe('user@example.com');
  });

  it('keeps the reservation while loading with one indicator and disabled Continue', async () => {
    nativeAuth.busy = 'otp-send';
    const renderer = await mountIdleAuth(vi.fn<StartFn>());
    expect(renderer.root.findByType('FormField').props.reserveErrorMessages).toHaveLength(3);
    expect(findButton(renderer.root, 'Continue with email').props.disabled).toBe(true);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
  });

  it('uses the keyboard submit action for an empty field too', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());
    const field = renderer.root.findByType('FormField');
    expect(field.props.error).toBeUndefined();
    await act(async () => {
      (field.props.onSubmitEditing as () => void)();
      await Promise.resolve();
    });
    expect(nativeAuth.requestEmailCode).toHaveBeenCalledWith('');
    expect(renderer.root.findByType('FormField')).toBeTruthy();
  });
});
