import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openBrowserAsync } from 'expo-web-browser';
import { AppleAuthenticationButtonStyle } from 'expo-apple-authentication';
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

// Which provider controls the screen renders: Apple availability and the
// Google client ID both come from outside the component.
const providers = vi.hoisted(() => ({ appleAvailable: false, googleConfigured: false }));

// What the screen reads from the hook: a fixed result object plus the one piece
// of state the busy treatment depends on.
const nativeAuth = vi.hoisted(() => ({
  busy: undefined as 'passkey' | undefined,
  signInWithPasskey: vi.fn(),
}));

vi.mock('@/lib/auth/passkey-client', () => ({
  passkeysSupported: () => passkeySupport.supported,
}));

vi.mock('@/lib/auth/use-native-auth', () => ({
  useNativeAuth: () => ({
    busy: nativeAuth.busy,
    googleConfigured: providers.googleConfigured,
    signInWithApple: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithPasskey: nativeAuth.signInWithPasskey,
    requestEmailCode: vi.fn(),
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

    act(() => {
      renderer.unmount();
    });
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

    act(() => {
      renderer.unmount();
    });
  });

  it('starts the passkey ceremony on press', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const btn = findButton(renderer.root, 'Sign in with a passkey');
    act(() => {
      (btn.props.onPress as () => void)();
    });

    expect(nativeAuth.signInWithPasskey).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
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

    act(() => {
      renderer.unmount();
    });
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

    act(() => {
      renderer.unmount();
    });
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

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the Terms and Privacy Policy line', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    expect(texts(renderer.root)).toContain('Terms');
    expect(texts(renderer.root)).toContain('Privacy Policy');

    act(() => {
      renderer.unmount();
    });
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

    act(() => {
      renderer.unmount();
    });
  });
});
