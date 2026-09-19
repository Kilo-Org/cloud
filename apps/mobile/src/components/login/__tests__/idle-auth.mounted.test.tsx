import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  signInWithPasskey: vi.fn(),
}));

vi.mock('@/lib/auth/passkey-client', () => ({
  passkeysSupported: () => passkeySupport.supported,
}));

vi.mock('@/lib/auth/use-native-auth', () => ({
  useNativeAuth: () => ({
    busy: nativeAuth.busy,
    googleConfigured: false,
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
  AppleAuthenticationButtonStyle: { WHITE: 0, BLACK: 1 },
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  isAvailableAsync: vi.fn().mockResolvedValue(false),
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

beforeEach(() => {
  ssoRecovery.value = null;
  nativeAuth.busy = undefined;
  nativeAuth.signInWithPasskey.mockClear();
  passkeySupport.supported = true;
  vi.mocked(openBrowserAsync).mockClear();
});

describe('IdleAuth SSO recovery', () => {
  beforeEach(() => {
    ssoRecovery.value = { email: 'user@example.com', ssoOrganizationId: 'org_1' };
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

    const terms = renderer.root.findByProps({
      accessibilityRole: 'link',
      accessibilityLabel: 'Terms',
    });
    act(() => {
      (terms.props.onPress as () => void)();
    });
    expect(openBrowserAsync).toHaveBeenCalledWith(TERMS_URL);

    const privacy = renderer.root.findByProps({
      accessibilityRole: 'link',
      accessibilityLabel: 'Privacy Policy',
    });
    act(() => {
      (privacy.props.onPress as () => void)();
    });
    expect(openBrowserAsync).toHaveBeenCalledWith(PRIVACY_URL);

    act(() => {
      renderer.unmount();
    });
  });

  it.each(['Terms', 'Privacy Policy'])(
    'gives %s a standalone touch target of at least 44dp',
    async label => {
      const renderer = await mountIdleAuth(vi.fn<StartFn>());
      const link = findText(renderer.root, label).parent;
      const className = link?.props.className as string;

      // NativeWind renders a `px` arbitrary value 1:1 as density-independent
      // pixels and Android rounds the physical layout down, so a 44dp floor
      // measured 115px = 43.81dp at density 420 (e1). Keep it above 44.
      expect(Number(/min-h-\[(\d+)px\]/.exec(className)?.[1])).toBeGreaterThan(44);
      expect(Number(/min-w-\[(\d+)px\]/.exec(className)?.[1])).toBeGreaterThan(44);
      expect(className).toContain('max-w-full');
      expect(className).toContain('active:opacity-70');
      expect(link?.type).toBe('Pressable');
      expect(link?.props.accessibilityRole).toBe('link');
      expect(link?.props.accessibilityLabel).toBe(label);
      expect(link?.parent?.type).toBe('View');
      expect(link?.parent?.props.className).toContain('flex-wrap');

      act(() => {
        renderer.unmount();
      });
    }
  );

  it('keeps legal targets unchanged and available while sign-in is busy', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);
    const originalLinks = renderer.root.findAllByProps({ accessibilityRole: 'link' });
    const originalClasses = originalLinks.map(link => link.props.className);

    act(() => {
      nativeAuth.busy = 'otp-send';
      renderer.update(createElement(IdleAuth, { start }));
    });

    const busyLinks = renderer.root.findAllByProps({ accessibilityRole: 'link' });
    expect(busyLinks).toHaveLength(2);
    expect(busyLinks.map(link => link.props.className)).toEqual(originalClasses);
    for (const link of busyLinks) {
      expect(link.props.disabled).not.toBe(true);
      act(() => {
        (link.props.onPress as () => void)();
      });
    }
    expect(openBrowserAsync).toHaveBeenNthCalledWith(1, TERMS_URL);
    expect(openBrowserAsync).toHaveBeenNthCalledWith(2, PRIVACY_URL);

    act(() => {
      renderer.unmount();
    });
  });
});
