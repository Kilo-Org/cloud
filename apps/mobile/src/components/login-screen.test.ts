/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as use-device-auth.test.ts) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// login-screen.test.ts — narrow contract tests plus mounted globe tests.
// The refresh boundary contract is verified through the useDeviceAuth hook's
// output shape; the language globe is verified by mounting LoginScreen with
// the native modules stubbed.

import { parseDeviceAuthTokenResponse } from '@/lib/auth/native-auth-contract';
import '@/i18n';
import { restoreLoginDrafts } from '@/lib/login-draft';
import { LoginScreen } from './login-screen';
import { errorMessage } from './login-screen-state';

// ── Hoisted mocks for the mounted globe tests ──────────────────────────────

const deviceAuth = vi.hoisted(() => ({
  status: 'idle' as string,
  token: undefined as string | undefined,
  code: undefined as string | undefined,
  refreshToken: undefined as string | undefined,
  expiresIn: undefined as number | undefined,
  error: undefined as string | undefined,
  verificationUrl: undefined as string | undefined,
  resumed: false,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  I18nManager: { isRTL: false },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('sonner-native', () => ({ toast: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/../assets/images/logo.png', () => ({ default: 1 }));
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding-state', () => ({
  resolveAppAwareKeyboardPadding: vi.fn(),
  resolveKeyboardPaddingEventsForPlatform: () => null,
}));
vi.mock('@/components/login/idle-auth', () => ({ IdleAuth: 'IdleAuth' }));
vi.mock('@/components/language-picker-sheet', () => ({
  LanguagePickerSheet: 'LanguagePickerSheet',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Globe: 'Globe', ExternalLink: 'ExternalLink' }));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { warning: vi.fn() } }));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ sessionEnded: false, signIn: vi.fn() }),
}));
vi.mock('@/lib/auth/use-device-auth', () => ({
  useDeviceAuth: () => ({
    status: deviceAuth.status,
    token: deviceAuth.token,
    code: deviceAuth.code,
    refreshToken: deviceAuth.refreshToken,
    expiresIn: deviceAuth.expiresIn,
    error: deviceAuth.error,
    verificationUrl: deviceAuth.verificationUrl,
    resumed: deviceAuth.resumed,
    start: vi.fn(),
    cancel: vi.fn(),
    openBrowser: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827', mutedForeground: '#6b7280' }),
}));
vi.mock('@/lib/login-draft', () => ({
  clearLoginDrafts: vi.fn(),
  persistLoginDrafts: vi.fn(),
  restoreLoginDrafts: vi.fn().mockResolvedValue(null),
}));

// ── Mounted globe helpers ──────────────────────────────────────────────────

function findGlobe(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const pressables = root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
  );
  const globe = pressables.find(pressable => pressable.props.accessibilityLabel === 'Language');
  if (!globe) {
    throw new Error('language globe not found');
  }
  return globe;
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

async function mountLoginScreen(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(LoginScreen));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('login-screen refresh boundary', () => {
  it('passes refreshToken and expiresIn through the approved token response', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 3600,
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 3600,
    });
  });

  it('handles an approved response without refresh pair (legacy)', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it('drops an incomplete pair (refreshToken without expiresIn) to token-only', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
      refreshToken: 'ref',
    });

    // An incomplete pair must never reach signIn as a refresh token.
    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it('drops an incomplete pair (expiresIn without refreshToken) to token-only', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
      expiresIn: 3600,
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it('handles a denied response', () => {
    const result = parseDeviceAuthTokenResponse({ status: 'denied' });
    expect(result).toEqual({ status: 'denied' });
  });

  it('handles an expired response', () => {
    const result = parseDeviceAuthTokenResponse({ status: 'expired' });
    expect(result).toEqual({ status: 'expired' });
  });

  it('handles a pending response', () => {
    const result = parseDeviceAuthTokenResponse({ status: 'pending' });
    expect(result).toEqual({ status: 'pending' });
  });
});

describe('login-screen error mapping', () => {
  it('maps expired to a distinct message', () => {
    expect(errorMessage('expired', undefined)).toBe(
      'Your sign-in code has expired. Please try again.'
    );
  });

  it('maps denied to a distinct message', () => {
    expect(errorMessage('denied', undefined)).toBe('Access was denied.');
  });

  it('falls back to the provided error for unknown status', () => {
    expect(errorMessage('error', 'custom error')).toBe('custom error');
  });

  it('falls back to default when no error is provided', () => {
    expect(errorMessage('error', undefined)).toBe('Something went wrong. Please try again.');
  });
});

describe('login-screen malformed poll boundary', () => {
  it('returns null for a 200 body with no token — prevents signIn call', () => {
    // When the server returns HTTP 200 but parse fails (no token),
    // the hook transitions to 'error' state, not 'approved'.
    // signIn is never called with a missing token.
    const result = parseDeviceAuthTokenResponse({ status: 'approved' });
    expect(result).toBeNull();
  });

  it('returns null for an empty 200 body — prevents signIn call', () => {
    const result = parseDeviceAuthTokenResponse({});
    expect(result).toBeNull();
  });

  it('returns null for a non-object 200 body — prevents signIn call', () => {
    const result = parseDeviceAuthTokenResponse(null);
    expect(result).toBeNull();
  });

  it('drops a partial pair so incomplete credentials never reach signIn', () => {
    // refreshToken present but expiresIn missing — must not reach signIn as a pair.
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
      refreshToken: 'ref',
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });
});

describe('login-screen language globe', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    deviceAuth.status = 'idle';
    deviceAuth.token = undefined;
    deviceAuth.code = undefined;
    deviceAuth.refreshToken = undefined;
    deviceAuth.expiresIn = undefined;
    deviceAuth.error = undefined;
    deviceAuth.verificationUrl = undefined;
    deviceAuth.resumed = false;
  });

  it('renders the globe and names it Language', async () => {
    const renderer = await mountLoginScreen();
    const globe = findGlobe(renderer.root);

    expect(globe.props.accessibilityRole).toBe('button');
    expect(globe.props.accessibilityLabel).toBe('Language');
    expect(globe.props.disabled).toBe(false);
    expect(globe.props.accessibilityState).toEqual({ disabled: false });

    const icons = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Globe'
    );
    expect(icons).toHaveLength(1);

    renderer.unmount();
  });

  it('disables the globe during pending auth', async () => {
    deviceAuth.status = 'pending';
    deviceAuth.code = 'UC-1234';

    const renderer = await mountLoginScreen();
    const globe = findGlobe(renderer.root);

    expect(globe.props.disabled).toBe(true);
    expect(globe.props.accessibilityState).toEqual({ disabled: true });

    renderer.unmount();
  });
});

describe('login-screen idle skeleton', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    deviceAuth.status = 'idle';
    deviceAuth.token = undefined;
    deviceAuth.code = undefined;
    deviceAuth.refreshToken = undefined;
    deviceAuth.expiresIn = undefined;
    deviceAuth.error = undefined;
    deviceAuth.verificationUrl = undefined;
    deviceAuth.resumed = false;
    vi.mocked(restoreLoginDrafts).mockResolvedValue({ email: '', ssoRecovery: null });
  });

  it('shows a form skeleton until the draft restore finishes', async () => {
    const state: {
      resolve: ((value: { email: string; ssoRecovery: null }) => void) | undefined;
    } = { resolve: undefined };
    vi.mocked(restoreLoginDrafts).mockReturnValue(
      new Promise(resolve => {
        state.resolve = resolve;
      })
    );

    const renderer = await mountLoginScreen();

    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(2);
    expect(findByType(renderer.root, 'IdleAuth')).toHaveLength(0);

    await act(async () => {
      state.resolve?.({ email: '', ssoRecovery: null });
      await Promise.resolve();
    });

    expect(findByType(renderer.root, 'IdleAuth')).toHaveLength(1);
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(0);

    renderer.unmount();
  });
});
