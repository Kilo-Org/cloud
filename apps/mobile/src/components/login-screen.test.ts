/* eslint-disable max-lines -- The mounted tests keep the refresh boundary, error mapping, globe, and draft-restore contracts together. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// login-screen.test.ts — narrow contract tests plus mounted globe tests.
// The refresh boundary contract is verified through the useDeviceAuth hook's
// output shape; the language globe is verified by mounting LoginScreen with
// the native modules stubbed.

import { parseDeviceAuthTokenResponse } from '@/lib/auth/native-auth-contract';
import { i18n } from '@/i18n';
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
const clearDeviceError = vi.hoisted(() => vi.fn());
const setLanguagePickerBridge = vi.hoisted(() => vi.fn());
// The session-ended announcement is asserted through this spy, so it must
// outlive a single render: the mock factory below runs per import, the spy is
// cleared per test.
const announcingWarning = vi.hoisted(() => vi.fn());
// `sessionEnded` is toggled per test to drive the login screen's announcement
// effect without re-mocking the module.
const authState = vi.hoisted(() => ({ sessionEnded: false }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
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
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { warning: announcingWarning },
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ sessionEnded: authState.sessionEnded, signIn: vi.fn() }),
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
    clearError: clearDeviceError,
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

function findButtonByLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance {
  const control = findByType(root, 'Button').find(
    button => button.props.accessibilityLabel === label
  );
  if (!control) {
    throw new Error(`button ${label} not found`);
  }
  return control;
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
  it('floors the keyboard-down inset at the platform bottom chrome', () => {
    // The reported inset is not a reliable floor for the chrome the platform
    // draws over the app: Android reports navigationBars() only and reports 0
    // when the window does not inset for the bar, so a bare inset let the
    // form's last control sit under the home indicator (landscape gesture bar).
    // 48 is the tallest bottom chrome either platform draws.
    expect(resolveKeyboardBottomPadding({ keyboardHeight: 0, bottomInset: 28 })).toBe(48);
    expect(resolveKeyboardBottomPadding({ keyboardHeight: 0, bottomInset: 0 })).toBe(48);
  });

  it('keeps a reported inset larger than the floor', () => {
    expect(resolveKeyboardBottomPadding({ keyboardHeight: 0, bottomInset: 63 })).toBe(63);
  });

  it('reserves exactly the reported height, which already reaches the screen bottom', () => {
    // The height comes from `react-native-keyboard-controller`, whose metric
    // spans the whole strip the IME hides on both platforms: Android edge-to-edge
    // keeps the navigation bar translucent, so nothing is subtracted, and iOS
    // reports the keyboard frame, which includes the home indicator. Adding the
    // bottom inset as well would float the form above the keyboard.
    expect(resolveKeyboardBottomPadding({ keyboardHeight: 300, bottomInset: 28 })).toBe(300);
  });

  it('ignores a negative reported height', () => {
    expect(resolveKeyboardBottomPadding({ keyboardHeight: -1, bottomInset: 28 })).toBe(48);
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

describe('login-screen device-code actions', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    deviceAuth.status = 'pending';
    deviceAuth.token = undefined;
    deviceAuth.code = 'UC-1234';
    deviceAuth.refreshToken = undefined;
    deviceAuth.expiresIn = undefined;
    deviceAuth.error = undefined;
    deviceAuth.verificationUrl = 'https://kilo.example/device';
    deviceAuth.resumed = false;
  });

  it('renders both device-code actions as icon-free label-only buttons', async () => {
    const renderer = await mountLoginScreen();

    const openInBrowser = findButtonByLabel(renderer.root, 'Open sign-in page in browser');
    const copyLink = findButtonByLabel(renderer.root, 'Copy sign-in link');

    // The pair reads as one iconography: each action is a single label child.
    expect(openInBrowser.children).toHaveLength(1);
    expect(copyLink.children).toHaveLength(1);

    const openChild = openInBrowser.children[0];
    const copyChild = copyLink.children[0];
    if (
      !openChild ||
      !copyChild ||
      typeof openChild === 'string' ||
      typeof copyChild === 'string'
    ) {
      throw new Error('expected a rendered label child for each action');
    }
    expect(openChild.type).toBe('Text');
    expect(copyChild.type).toBe('Text');
    expect(
      openInBrowser.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'ExternalLink'
      )
    ).toHaveLength(0);

    renderer.unmount();
  });
});

describe('login-screen timeout error dismissal', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    deviceAuth.status = 'error';
    deviceAuth.token = undefined;
    deviceAuth.code = undefined;
    deviceAuth.refreshToken = undefined;
    deviceAuth.expiresIn = undefined;
    deviceAuth.error = i18n.t('authErrors.signInTimedOut');
    deviceAuth.verificationUrl = undefined;
    deviceAuth.resumed = false;
    clearDeviceError.mockClear();
  });

  it('shows the timed-out message above the idle form and clears it when a new attempt starts', async () => {
    const renderer = await mountLoginScreen();

    const timeout = i18n.t('authErrors.signInTimedOut');
    expect(findByType(renderer.root, 'Text').some(node => node.props.children === timeout)).toBe(
      true
    );

    // The retry form carries the shell's error-clear so a new attempt dismisses
    // the stale timeout banner at the moment it starts.
    const idleAuth = findByType(renderer.root, 'IdleAuth')[0];
    if (!idleAuth) {
      throw new Error('IdleAuth not found');
    }
    expect(idleAuth.props.onSignInStart).toBe(clearDeviceError);

    act(() => {
      (idleAuth.props.onSignInStart as () => void)();
    });
    expect(clearDeviceError).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('keeps the idle form on screen while a restarted attempt is pending without a code', async () => {
    const renderer = await mountLoginScreen();
    expect(findByType(renderer.root, 'IdleAuth')).toHaveLength(1);

    // A new browser attempt clears the terminal error and enters the
    // start-in-flight state (`pending` with no code yet). The form must stay on
    // screen instead of being replaced by a starting spinner, so the retry never
    // reads as a blank screen.
    deviceAuth.status = 'pending';
    deviceAuth.code = undefined;
    deviceAuth.error = undefined;
    act(() => {
      renderer.update(createElement(LoginScreen));
    });

    expect(findByType(renderer.root, 'IdleAuth')).toHaveLength(1);
    const timeout = i18n.t('authErrors.signInTimedOut');
    expect(findByType(renderer.root, 'Text').some(node => node.props.children === timeout)).toBe(
      false
    );

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

describe('login-screen approved wait surface', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    deviceAuth.status = 'approved';
    deviceAuth.token = 'tok';
    deviceAuth.code = undefined;
    deviceAuth.refreshToken = undefined;
    deviceAuth.expiresIn = undefined;
    deviceAuth.error = undefined;
    deviceAuth.verificationUrl = undefined;
    deviceAuth.resumed = false;
  });

  // The hold between the device approving and the root layout redirecting used
  // to be a bare spinner on the app background: the explorer read it as an
  // unbranded blank page (signin-language). It is now the shared branded wait
  // surface, the same one the root layout paints over its hidden windows.
  it('renders the branded wait surface while the approved token is written', async () => {
    const renderer = await mountLoginScreen();

    const progress = renderer.root.findAll(node => node.props.accessibilityRole === 'progressbar');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.props.accessibilityLabel).toBe('Loading…');

    const logo = findByType(renderer.root, 'Image').find(
      node => node.props.accessibilityLabel === 'Kilo logo'
    );
    expect(logo).toBeDefined();
    expect(findByType(renderer.root, 'Text').some(node => node.children[0] === 'Loading…')).toBe(
      true
    );

    renderer.unmount();
  });
});

describe('login-screen session-ended announcement', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    announcingWarning.mockClear();
    authState.sessionEnded = false;
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

  it('announces the ended session once and stays silent while it is live', async () => {
    // s2 reaches `signOut(true)` only on a server-confirmed 401, so `sessionEnded`
    // is the only signal that the stored session is gone. The login screen must
    // announce it once, keyed so a remount while still signed out does not
    // repeat the toast.
    authState.sessionEnded = true;
    const ended = await mountLoginScreen();

    expect(announcingWarning).toHaveBeenCalledTimes(1);
    expect(announcingWarning).toHaveBeenCalledWith(i18n.t('login.sessionEnded'), {
      id: 'session-ended',
    });
    ended.unmount();

    announcingWarning.mockClear();
    authState.sessionEnded = false;
    const live = await mountLoginScreen();

    expect(announcingWarning).not.toHaveBeenCalled();
    live.unmount();
  });
});
