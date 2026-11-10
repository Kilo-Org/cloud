import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type PendingLinkOffer } from '@/lib/auth/native-auth-contract';
import { type PendingLinkFailure } from '@/lib/auth/pending-link';
import '@/i18n';

import { IdleAuth } from '../idle-auth';

type StartFn = (mode: 'signin' | 'sso', ssoEmail?: string, token?: string) => Promise<void>;

// What the screen reads from the hook; the request wiring is covered by the hook's own suite.
const nativeAuth = vi.hoisted(() => ({
  busy: undefined as 'apple' | 'google' | 'passkey' | 'otp-send' | undefined,
  pendingLinkFailure: undefined as PendingLinkFailure | undefined,
  requestEmailCode: vi.fn(),
  signInWithGoogle: vi.fn(),
}));

vi.mock('@/lib/auth/use-native-auth', () => ({
  useNativeAuth: () => ({
    busy: nativeAuth.busy,
    emailErrorKey: undefined,
    clearEmailError: vi.fn(),
    googleConfigured: true,
    signInWithApple: vi.fn(),
    signInWithGoogle: nativeAuth.signInWithGoogle,
    signInWithPasskey: vi.fn(),
    requestEmailCode: nativeAuth.requestEmailCode,
    verifyEmailCode: vi.fn(),
    ssoRecovery: null,
    clearSsoRecovery: vi.fn(),
    handleSsoError: vi.fn(),
    pendingLinkFailure: nativeAuth.pendingLinkFailure,
    clearPendingLinkFailure: vi.fn(),
  }),
}));

vi.mock('@/lib/auth/passkey-client', () => ({ passkeysSupported: () => true }));
vi.mock('@/lib/login-draft', () => ({
  setLoginEmailDraft: vi.fn(),
  setSsoRecoveryDraft: vi.fn(),
}));
vi.mock('expo-apple-authentication', () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(false),
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  View: 'View',
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/login/email-otp-form', () => ({ EmailOtpForm: 'EmailOtpForm' }));
vi.mock('@/components/login/apple-logo', () => ({ AppleLogo: 'AppleLogo' }));
vi.mock('@/components/login/google-logo', () => ({ GoogleLogo: 'GoogleLogo' }));
vi.mock('@/components/ui/icons', () => ({ KeyRound: 'KeyRound' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('@/lib/config', () => ({
  TERMS_URL: 'https://app.kilo.ai/terms-app',
  PRIVACY_URL: 'https://app.kilo.ai/privacy-app',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#14130f', mutedForeground: '#6f6a61' }),
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

function offer(overrides: Partial<PendingLinkOffer> = {}): PendingLinkOffer {
  return {
    token: 'link-token',
    provider: 'github',
    email: 'person@example.com',
    methods: ['google', 'passkey', 'gitlab'],
    emailCode: true,
    expiresAt: NOW + 15 * 60 * 1000,
    ...overrides,
  };
}

const renderers: R[] = [];

async function mount(props: {
  start?: StartFn;
  pendingLink: PendingLinkOffer | null;
  pendingLinkRefused?: boolean;
  onClearPendingLink?: () => void;
}): Promise<R> {
  const ref: { current: R | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(IdleAuth, {
        start: props.start ?? vi.fn<StartFn>(),
        pendingLink: props.pendingLink,
        pendingLinkRefused: props.pendingLinkRefused,
        onPendingLink: vi.fn<(link: PendingLinkOffer) => void>(),
        onClearPendingLink: props.onClearPendingLink ?? vi.fn<() => void>(),
      })
    );
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  renderers.push(ref.current);
  return ref.current;
}

function isHost(n: I, name: string): boolean {
  return typeof n.type === 'string' && (n.type as string) === name;
}

function texts(root: I): string[] {
  return root
    .findAll(n => isHost(n, 'Text') && typeof n.props.children === 'string')
    .map(n => n.props.children as string);
}

function buttonLabels(root: I): string[] {
  return root.findAll(n => isHost(n, 'Button')).map(n => n.props.accessibilityLabel as string);
}

function press(root: I, label: string) {
  const button = root.find(n => isHost(n, 'Button') && n.props.accessibilityLabel === label);
  (button.props.onPress as () => void)();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  nativeAuth.busy = undefined;
  nativeAuth.pendingLinkFailure = undefined;
});

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('IdleAuth pending account link', () => {
  it('names the account and offers each method this device can resolve', async () => {
    const renderer = await mount({ pendingLink: offer() });

    expect(texts(renderer.root)).toContain(
      'An account already uses person@example.com. Sign in with one of its methods to add GitHub.'
    );
    expect(buttonLabels(renderer.root)).toEqual([
      'Sign in with Google',
      'Sign in with a passkey',
      'Email me a sign-in code',
      'Continue in browser',
      'Start again',
    ]);
    // The landing's own email field is not part of this screen.
    expect(renderer.root.findAll(n => isHost(n, 'FormField'))).toHaveLength(0);
  });

  it('omits the browser and email options the account does not have', async () => {
    const renderer = await mount({
      pendingLink: offer({ methods: ['google'], emailCode: false }),
    });

    expect(buttonLabels(renderer.root)).toEqual(['Sign in with Google', 'Start again']);
  });

  it('starts the browser sign-in and the email code with the link they resolve', async () => {
    const start = vi.fn<StartFn>().mockResolvedValue(undefined);
    nativeAuth.requestEmailCode.mockResolvedValue(false);
    const renderer = await mount({ start, pendingLink: offer() });

    await act(async () => {
      press(renderer.root, 'Continue in browser');
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledWith('signin', undefined, 'link-token');

    await act(async () => {
      press(renderer.root, 'Email me a sign-in code');
      await Promise.resolve();
    });
    expect(nativeAuth.requestEmailCode).toHaveBeenCalledWith('person@example.com');
  });

  it('shows the code step for the account address once the code is sent', async () => {
    nativeAuth.requestEmailCode.mockResolvedValue(true);
    const renderer = await mount({ pendingLink: offer() });

    await act(async () => {
      press(renderer.root, 'Email me a sign-in code');
      await Promise.resolve();
    });

    const form = renderer.root.find(n => isHost(n, 'EmailOtpForm'));
    expect(form.props.email).toBe('person@example.com');
  });

  it('keeps the options beside a retryable refusal', async () => {
    nativeAuth.pendingLinkFailure = {
      message: 'Passkey sign-in was cancelled. Please try again.',
      retryable: true,
    };
    const renderer = await mount({ pendingLink: offer() });

    expect(texts(renderer.root)).toContain('Passkey sign-in was cancelled. Please try again.');
    expect(buttonLabels(renderer.root)).toContain('Sign in with Google');
  });

  it('leaves only Start again after a refusal no method can change', async () => {
    nativeAuth.pendingLinkFailure = {
      message: 'This account has been blocked. Please contact support.',
      retryable: false,
    };
    const onClearPendingLink = vi.fn<() => void>();
    const renderer = await mount({ pendingLink: offer(), onClearPendingLink });

    expect(texts(renderer.root)).toContain(
      'This account has been blocked. Please contact support.'
    );
    expect(buttonLabels(renderer.root)).toEqual(['Start again']);

    act(() => {
      press(renderer.root, 'Start again');
    });
    expect(onClearPendingLink).toHaveBeenCalledTimes(1);
  });

  it('leaves only Start again when the account has no method to offer', async () => {
    const renderer = await mount({ pendingLink: offer({ methods: [], emailCode: false }) });

    expect(texts(renderer.root)).toContain(
      "This account has no other sign-in method, so GitHub can't be added."
    );
    expect(buttonLabels(renderer.root)).toEqual(['Start again']);
  });

  it('turns into the expired state at expiresAt', async () => {
    const renderer = await mount({ pendingLink: offer({ expiresAt: NOW + 1000 }) });
    expect(buttonLabels(renderer.root)).toContain('Sign in with Google');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(texts(renderer.root)).toContain('This request to add GitHub has expired.');
    expect(buttonLabels(renderer.root)).toEqual(['Start again']);
  });

  it('opens already expired when the link lapsed while the screen was away', async () => {
    const renderer = await mount({ pendingLink: offer({ expiresAt: NOW - 1 }) });

    expect(texts(renderer.root)).toContain('This request to add GitHub has expired.');
    expect(buttonLabels(renderer.root)).toEqual(['Start again']);
  });

  it('shows the expired state when the browser start refused the link early', async () => {
    const renderer = await mount({ pendingLink: offer(), pendingLinkRefused: true });

    expect(texts(renderer.root)).toContain('This request to add GitHub has expired.');
    expect(buttonLabels(renderer.root)).toEqual(['Start again']);
  });

  it('keeps the plain landing without a pending link', async () => {
    const renderer = await mount({ pendingLink: null });

    expect(buttonLabels(renderer.root)).toContain('Continue with email');
    expect(buttonLabels(renderer.root)).not.toContain('Start again');
  });
});
