import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openBrowserAsync } from 'expo-web-browser';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config';

import { IdleAuth } from '../idle-auth';
import '@/i18n';

type StartFn = (mode: 'signin' | 'sso', ssoEmail?: string) => Promise<void>;

type SsoRecoveryFixture = { email: string; ssoOrganizationId: string | undefined } | null;

const ssoRecovery: { value: SsoRecoveryFixture } = vi.hoisted(() => ({
  value: { email: 'user@example.com', ssoOrganizationId: 'org_1' },
}));

// The native passkey module is absent in the test runtime, so the capability is
// the one input the screen reads from the client module.
const passkeySupport = vi.hoisted(() => ({ supported: true }));

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
    googleConfigured: false,
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
  AppleAuthenticationButtonStyle: { WHITE: 0, BLACK: 1 },
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  isAvailableAsync: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
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

function findText(root: I, text: string): I {
  const nodes = root.findAll(
    n => typeof n.type === 'string' && (n.type as string) === 'Text' && n.props.children === text
  );
  const node = nodes[0];
  if (!node || nodes.length !== 1) {
    throw new Error(`text "${text}" found ${nodes.length} times, expected once`);
  }
  return node;
}

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

  it('opens the browser for Terms and Privacy Policy', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    const terms = findText(renderer.root, 'Terms');
    act(() => {
      (terms.props.onPress as () => void)();
    });
    expect(openBrowserAsync).toHaveBeenCalledWith(TERMS_URL);

    const privacy = findText(renderer.root, 'Privacy Policy');
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
    expect(renderer.root.findByType('FormField').props.error).toBe(nativeAuth.emailError);
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
