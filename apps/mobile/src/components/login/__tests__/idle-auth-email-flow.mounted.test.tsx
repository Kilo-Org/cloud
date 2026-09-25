/* eslint-disable max-lines -- the harness shares one mock block with the real hook under test */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import type * as AuthFetchTypes from '@/lib/auth/auth-fetch';

import '@/i18n';

// Mock @/lib/config to avoid pulling in react-native at module import time.
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
  GOOGLE_WEB_CLIENT_ID: 'web-client-id',
  TERMS_URL: 'https://app.kilo.ai/terms-app',
  PRIVACY_URL: 'https://app.kilo.ai/privacy-app',
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

vi.mock('@expo/app-integrity', () => ({
  isSupported: false,
  generateKeyAsync: vi.fn(),
  attestKeyAsync: vi.fn(),
  generateAssertionAsync: vi.fn(),
  prepareIntegrityTokenProviderAsync: vi.fn(),
  requestIntegrityCheckAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: 'AppleAuthenticationButton',
  AppleAuthenticationButtonStyle: { WHITE: 0, BLACK: 1 },
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  formatFullName: vi.fn(),
  signInAsync: vi.fn(),
  isAvailableAsync: vi.fn().mockResolvedValue(false),
}));

vi.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: vi.fn(), hasPlayServices: vi.fn(), signIn: vi.fn() },
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 1 },
  digestStringAsync: vi.fn(),
  getRandomBytesAsync: vi.fn(),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(() => ({ signIn: vi.fn() })),
}));

vi.mock('@sentry/react-native', () => ({ addBreadcrumb: vi.fn() }));

vi.mock('@/lib/auth/auth-fetch', async importOriginal => {
  const mod = await importOriginal<typeof AuthFetchTypes>();
  return { ...mod, postAuth: vi.fn() };
});

vi.mock('@/lib/login-draft', () => ({
  setLoginEmailDraft: vi.fn(),
  setSsoRecoveryDraft: vi.fn(),
}));

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: vi.fn(),
}));

// UI primitives render as host strings so the test can drive their props.
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/login/email-otp-form', () => ({ EmailOtpForm: 'EmailOtpForm' }));
vi.mock('@/components/login/apple-logo', () => ({ AppleLogo: 'AppleLogo' }));
vi.mock('@/components/login/google-logo', () => ({ GoogleLogo: 'GoogleLogo' }));
vi.mock('@/components/ui/icons', () => ({ KeyRound: 'KeyRound' }));

// The idle screen reads the foreground ink for the Apple mark; the real hook
// pulls expo-router, which the mounted project cannot load.
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#14130f', mutedForeground: '#6f6a61' }),
}));

const { IdleAuth } = await import('@/components/login/idle-auth');
const { postAuth } = await import('@/lib/auth/auth-fetch');
const mockPostAuth = vi.mocked(postAuth);

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;
type StartFn = (mode: 'signin' | 'sso', ssoEmail?: string) => Promise<void>;

function findAll(root: I, type: string): I[] {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === type);
}

function continueButton(root: I): I {
  const button = findAll(root, 'Button').find(
    b => (b.props.accessibilityLabel as string) === 'Continue with email'
  );
  if (!button) {
    throw new Error('Continue with email button not found');
  }
  return button;
}

async function mountIdleAuth(): Promise<R> {
  const ref: { current: R | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(React.createElement(IdleAuth, { start: vi.fn<StartFn>() }));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('IdleAuth email sign-in flow (real useNativeAuth)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('types an email, taps Continue, posts the code request, and shows the code screen', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000001' },
    });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('User@Example.com ');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPostAuth).toHaveBeenCalledWith('/api/auth/native/otp', {
      email: 'user@example.com',
    });
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('presses the keyboard Go key and shows the code screen', async () => {
    mockPostAuth.mockResolvedValue({ ok: true, data: { success: true } });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('go@example.com');
    });

    await act(async () => {
      (field.props.onSubmitEditing as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the empty-email error under the field and never posts', async () => {
    const renderer = await mountIdleAuth();

    // The field starts empty: tapping Continue is the scenario under test.
    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
    });

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    // The message is rendered through FormField's error slot (a visible,
    // announced status), never as a toast that leaves the landing silent.
    expect(field.props.error).toBe('Please enter your email address.');
    expect(mockPostAuth).not.toHaveBeenCalled();
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(0);
    const { toast } = await import('sonner-native');
    expect(toast.error).not.toHaveBeenCalled();

    // Typing clears the message so the control is not left in an error state.
    act(() => {
      (field.props.onChangeText as (value: string) => void)('user@example.com');
    });
    expect(findAll(renderer.root, 'FormField')[0]?.props.error).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  it('shows an error and stays on the landing when the request fails', async () => {
    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: undefined,
      ssoOrganizationId: undefined,
    });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('fail@example.com');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const { toast } = await import('sonner-native');
    expect(toast.error).toHaveBeenCalled();
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the timeout toast, keeps the landing, then advances on retry', async () => {
    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      ssoOrganizationId: undefined,
    });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('timeout@example.com');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const { toast } = await import('sonner-native');
    expect(toast.error).toHaveBeenCalledWith('Sign-in timed out. Please try again.');
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(0);
    // The landing is intact with the Continue control back in its slot.
    expect(findAll(renderer.root, 'FormField')).toHaveLength(1);
    expect(continueButton(renderer.root)).toBeTruthy();

    // Recovery: the next submit is accepted and reaches the code screen.
    mockPostAuth.mockResolvedValue({ ok: true, data: { success: true } });
    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });
});
