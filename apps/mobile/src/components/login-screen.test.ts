/* eslint-disable max-lines -- The mounted tests keep the refresh boundary, error mapping, globe, and draft-restore contracts together. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppStateStatus, Keyboard, type KeyboardEvent, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// login-screen.test.ts — narrow contract tests plus mounted globe tests.
// The refresh boundary contract is verified through the useDeviceAuth hook's
// output shape; the language globe is verified by mounting LoginScreen with
// the native modules stubbed.

import { parseDeviceAuthTokenResponse } from '@/lib/auth/native-auth-contract';
import '@/i18n';
import {
  clearPersistedLoginDrafts,
  persistLoginDrafts,
  restoreLoginDrafts,
} from '@/lib/login-draft';
import { LoginScreen } from './login-screen';
import { errorMessage, resolveKeyboardBottomPadding } from './login-screen-state';

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
const push = vi.hoisted(() => vi.fn());
const setLanguagePickerBridge = vi.hoisted(() => vi.fn());
const addAppStateListener = vi.hoisted(() =>
  vi.fn((_event: 'change', _listener: (state: AppStateStatus) => void) => ({ remove: vi.fn() }))
);

vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { addEventListener: addAppStateListener },
  I18nManager: { isRTL: false },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));
vi.mock('sonner-native', () => ({ toast: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/../assets/images/logo.png', () => ({ default: 1 }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/login/idle-auth', () => ({ IdleAuth: 'IdleAuth' }));
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
  clearPersistedLoginDrafts: vi.fn(),
  persistLoginDrafts: vi.fn(),
  restoreLoginDrafts: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/picker-bridge', () => ({
  setLanguagePickerBridge,
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

function keyboardEventsFor(platform: 'android' | 'ios') {
  return platform === 'ios'
    ? ({ show: 'keyboardWillShow', hide: 'keyboardWillHide' } as const)
    : ({ show: 'keyboardDidShow', hide: 'keyboardDidHide' } as const);
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

describe('login-screen keyboard bottom padding', () => {
  it.each(['android', 'ios'] as const)(
    'reserves the bottom inset alone for the %s keyboard-down state',
    platform => {
      expect(resolveKeyboardBottomPadding({ keyboardHeight: 0, bottomInset: 28, platform })).toBe(
        28
      );
    }
  );

  it('adds the bottom inset to Android, whose keyboard metric stops at the navigation bar', () => {
    expect(
      resolveKeyboardBottomPadding({ keyboardHeight: 300, bottomInset: 28, platform: 'android' })
    ).toBe(328);
  });

  it('keeps the iOS keyboard frame height, which already includes the home indicator', () => {
    expect(
      resolveKeyboardBottomPadding({ keyboardHeight: 300, bottomInset: 28, platform: 'ios' })
    ).toBe(300);
  });

  it('ignores a negative reported height', () => {
    expect(
      resolveKeyboardBottomPadding({ keyboardHeight: -1, bottomInset: 28, platform: 'android' })
    ).toBe(28);
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
    push.mockClear();
    setLanguagePickerBridge.mockClear();
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

  it('renders the globe after the screen without raising it above the toaster', async () => {
    const renderer = await mountLoginScreen();
    const globe = findGlobe(renderer.root);
    const parent = globe.parent;
    if (!parent) {
      throw new Error('language globe parent not found');
    }

    const scrollViewIndex = parent.children.findIndex(
      child => typeof child !== 'string' && (child.type as string) === 'ScrollView'
    );
    expect(scrollViewIndex).toBeGreaterThanOrEqual(0);
    expect(parent.children.indexOf(globe)).toBeGreaterThan(scrollViewIndex);
    expect(globe.props.className).not.toMatch(/\bz-/);

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

  it('globe press sets the language bridge and opens the auth language picker', async () => {
    const renderer = await mountLoginScreen();
    const globe = findGlobe(renderer.root);

    act(() => {
      (globe.props.onPress as () => void)();
    });

    expect(setLanguagePickerBridge).toHaveBeenCalledTimes(1);
    expect(setLanguagePickerBridge).toHaveBeenCalledWith({ beforeReload: persistLoginDrafts });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/(auth)/language-picker');

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
    vi.mocked(clearPersistedLoginDrafts).mockClear();
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

  it('deletes the persisted drafts only after applying them', async () => {
    const state: {
      resolve: ((value: { email: string; ssoRecovery: null }) => void) | undefined;
    } = { resolve: undefined };
    vi.mocked(restoreLoginDrafts).mockReturnValue(
      new Promise(resolve => {
        state.resolve = resolve;
      })
    );

    const renderer = await mountLoginScreen();

    expect(clearPersistedLoginDrafts).not.toHaveBeenCalled();

    await act(async () => {
      state.resolve?.({ email: '', ssoRecovery: null });
      await Promise.resolve();
    });

    expect(clearPersistedLoginDrafts).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});

describe('login-screen bottom-bar clearance', () => {
  beforeEach(() => {
    deviceAuth.status = 'idle';
    deviceAuth.token = undefined;
    deviceAuth.code = undefined;
    Platform.OS = 'android';
    vi.mocked(Keyboard.addListener).mockClear();
    addAppStateListener.mockClear();
    vi.mocked(useSafeAreaInsets).mockReturnValue({ top: 24, bottom: 28, left: 0, right: 0 });
    vi.mocked(restoreLoginDrafts).mockResolvedValue({ email: '', ssoRecovery: null });
  });

  afterEach(() => {
    Platform.OS = 'ios';
    vi.mocked(useSafeAreaInsets).mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  function scrollViewport(renderer: TestRenderer.ReactTestRenderer) {
    const scroll = findByType(renderer.root, 'ScrollView')[0];
    if (!scroll?.parent) {
      throw new Error('login scroll viewport not found');
    }
    expect(scroll.props.className).toContain('flex-1');
    expect(scroll.props.contentContainerClassName).toContain('flex-grow');
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    return scroll.parent;
  }

  function emitKeyboard(
    eventName: 'keyboardDidShow' | 'keyboardDidHide' | 'keyboardWillShow' | 'keyboardWillHide',
    height = 0
  ) {
    const subscription = vi
      .mocked(Keyboard.addListener)
      .mock.calls.find(([name]) => name === eventName);
    if (!subscription) {
      throw new Error(`missing ${eventName} listener`);
    }
    const event: KeyboardEvent = {
      duration: 0,
      easing: 'keyboard',
      endCoordinates: { height, width: 360, screenX: 0, screenY: 640 - height },
    };
    act(() => {
      subscription[1](event);
    });
  }

  it.each(['android', 'ios'] as const)(
    'keeps the %s bottom bar outside the scroll viewport with a long email',
    async platform => {
      Platform.OS = platform;
      const email = 'long.email.address@subdomain.example-very-long-domain-name.co.uk';
      vi.mocked(restoreLoginDrafts).mockResolvedValue({ email, ssoRecovery: null });
      const renderer = await mountLoginScreen();

      expect(findByType(renderer.root, 'IdleAuth')[0]?.props.initialEmail).toBe(email);
      expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: 28 });
      // One padded wrapper for both platforms; the platform-gated
      // KeyboardAvoidingView is gone.
      expect(findByType(renderer.root, 'KeyboardAvoidingView')).toHaveLength(0);

      renderer.unmount();
    }
  );

  it.each(['idle', 'pending', 'expired', 'error', 'denied'])(
    'reserves the bottom bar for the %s auth state',
    async status => {
      deviceAuth.status = status;
      const renderer = await mountLoginScreen();

      expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: 28 });

      renderer.unmount();
    }
  );

  it('reserves the bottom bar while the draft placeholder is visible', async () => {
    const draft = Promise.withResolvers<Awaited<ReturnType<typeof restoreLoginDrafts>>>();
    vi.mocked(restoreLoginDrafts).mockReturnValue(draft.promise);
    const renderer = await mountLoginScreen();

    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(2);
    expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: 28 });

    await act(async () => {
      draft.resolve({ email: '', ssoRecovery: null });
      await draft.promise;
    });
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(0);
    expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: 28 });

    renderer.unmount();
  });

  it.each(['android', 'ios'] as const)(
    'pads the %s keyboard height through the same listener pair',
    async platform => {
      const events = keyboardEventsFor(platform);
      Platform.OS = platform;
      const renderer = await mountLoginScreen();

      // Same wrapper, one listener pair per platform: the only keyboard-event
      // difference is which pair that platform fires.
      expect(vi.mocked(Keyboard.addListener).mock.calls.map(([name]) => name)).toEqual([
        events.show,
        events.hide,
      ]);
      expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: 28 });

      // Android's reported height excludes the navigation bar, so the reserved
      // inset is added on top; iOS reports the keyboard window frame, whose
      // height already covers the home indicator, so the inset is not added
      // twice while the keyboard is up (it would leave a gap above the IME).
      emitKeyboard(events.show, 300);
      expect(scrollViewport(renderer).props.style).toEqual({
        paddingBottom: platform === 'android' ? 328 : 300,
      });

      emitKeyboard(events.hide);
      expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: 28 });

      emitKeyboard(events.show, 0);
      expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: 28 });

      renderer.unmount();
    }
  );

  it.each(['android', 'ios'] as const)(
    'clears stale %s keyboard occlusion on background without dropping the bottom bar',
    async platform => {
      Platform.OS = platform;
      const renderer = await mountLoginScreen();
      emitKeyboard(keyboardEventsFor(platform).show, 300);
      const subscription = addAppStateListener.mock.calls[0];
      if (!subscription) {
        throw new Error('missing app state listener');
      }

      act(() => {
        subscription[1]('background');
      });
      expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: 28 });

      renderer.unmount();
    }
  );

  it('tracks bottom inset changes, including devices without a bottom bar', async () => {
    const renderer = await mountLoginScreen();

    for (const bottom of [48, 0]) {
      vi.mocked(useSafeAreaInsets).mockReturnValue({ top: 24, bottom, left: 0, right: 0 });
      act(() => {
        renderer.update(createElement(LoginScreen));
      });
      expect(scrollViewport(renderer).props.style).toEqual({ paddingBottom: bottom });
    }

    renderer.unmount();
  });
});
