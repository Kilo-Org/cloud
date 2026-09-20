import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openBrowserAsync } from 'expo-web-browser';
import { MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
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
  busy: undefined as 'passkey' | undefined,
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

    act(() => {
      renderer.unmount();
    });
  });
});
