/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree, and @testing-library/react-native cannot be transformed by the current vitest pipeline (react-native ships Flow). See src/test/render-with-providers.tsx. */
/* eslint-disable max-lines -- mounted route outcomes and Settings recovery share the native boundary harness. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import AgentSessionList, { buildGitHubInstallOutcomeAlert } from './index';
import {
  getGitHubInstallReturnOutcome,
  setGitHubInstallReturnOutcome,
} from '@/lib/github-install-return';
import {
  _resetGlanceablePersistForTests,
  _setLastGlanceableSnapshotForTests,
} from '@/lib/glanceable/persist';
import {
  type GlanceableSink,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from '@/lib/glanceable/sink-registry';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

const alertMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => ({ OS: 'ios' }));
const mintInstallStateMock = vi.hoisted(() => vi.fn());
const openAuthSessionMock = vi.hoisted(() => vi.fn());
const openBrowserMock = vi.hoisted(() => vi.fn());
const focusedRoute = vi.hoisted(() => ({ focused: true }));
const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
const activityKit = vi.hoisted(() => ({ denied: false, available: false, settingsOpen: false }));

vi.mock('react-native', () => ({
  Alert: { alert: alertMock },
  Platform: platformMock,
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return {
        remove: () => {
          appStateListeners.delete(listener);
        },
      };
    },
  },
  Linking: {
    openSettings: () => {
      activityKit.settingsOpen = true;
    },
  },
}));

vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useFocusEffect: (effect: Parameters<typeof useEffect>[0]) => {
      const focused = focusedRoute.focused;
      useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
  };
});

// `failIdentityReadOnce` fails the identity read alone. The master-switch read
// runs first, and its own failure keeps the surfaces on rather than skipping
// recovery, so a first-call rejection would not exercise the identity path.
const storage = vi.hoisted(() => ({ failIdentityReadOnce: false }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn((key: string) => {
    if (key !== ACTIVE_USER_ID_KEY) {
      return null;
    }
    if (storage.failIdentityReadOnce) {
      storage.failIdentityReadOnce = false;
      throw new Error('storage unavailable');
    }
    return 'u1';
  }),
}));

vi.mock('@/glanceable-ios/ios-sink', () => ({
  getActivityKitDenied: () => activityKit.denied,
  clearActivityKitDeniedIfAvailable: () => {
    if (!activityKit.denied || !activityKit.available) {
      return false;
    }
    activityKit.denied = false;
    return true;
  },
}));

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: openAuthSessionMock,
  openBrowserAsync: openBrowserMock,
}));

vi.mock('@/lib/config', () => ({
  WEB_BASE_URL: 'https://web.test',
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    githubApps: {
      mintInstallState: { mutate: mintInstallStateMock },
    },
  },
}));

vi.mock('@/components/agents/session-list-screen', () => ({
  AgentSessionListScreen: () => null,
}));

type AlertButton = { text: string; onPress?: () => void };

const noOp = () => undefined;

function mountRoute() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(AgentSessionList));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function lastAlertButtons(): AlertButton[] | undefined {
  return alertMock.mock.calls.at(-1)?.[2] as AlertButton[] | undefined;
}

describe('buildGitHubInstallOutcomeAlert (C13 outcome states)', () => {
  it('returns null for the empty state (no return outcome)', () => {
    expect(buildGitHubInstallOutcomeAlert(null, () => undefined)).toBeNull();
  });

  it('happy state: connected message and Continue, no recovery action', () => {
    expect(buildGitHubInstallOutcomeAlert({ kind: 'success' }, () => undefined)).toEqual({
      title: 'GitHub App installed',
      message: 'Your repositories are now connected.',
      buttons: [{ text: 'Continue' }],
    });
  });

  it('pending state: admin approval message and Done', () => {
    expect(buildGitHubInstallOutcomeAlert({ kind: 'pending' }, () => undefined)).toEqual({
      title: 'Awaiting admin approval',
      message: 'An organization admin must approve the installation request.',
      buttons: [{ text: 'Done' }],
    });
  });

  it('retryable state: Try again wires the recovery callback', () => {
    const alert = buildGitHubInstallOutcomeAlert(
      { kind: 'error', code: 'installation_failed' },
      noOp
    );
    expect(alert?.title).toBe('Installation did not complete');
    expect(alert?.buttons).toHaveLength(1);
    expect(alert?.buttons[0]?.text).toBe('Try again');
    expect(alert?.buttons[0]?.onPress).toBe(noOp);
  });

  it('non-retryable states: show the reason and Back, never retry', () => {
    for (const code of [
      'install_state_user_mismatch',
      'not_installation_admin',
      'installation_already_claimed',
    ] as const) {
      const alert = buildGitHubInstallOutcomeAlert({ kind: 'error', code }, () => undefined);
      expect(alert?.buttons).toEqual([{ text: 'Back' }]);
      expect(alert?.buttons[0]?.onPress).toBeUndefined();
    }
    expect(
      buildGitHubInstallOutcomeAlert(
        { kind: 'error', code: 'install_state_user_mismatch' },
        () => undefined
      )?.title
    ).toBe('Account mismatch');
    expect(
      buildGitHubInstallOutcomeAlert(
        { kind: 'error', code: 'not_installation_admin' },
        () => undefined
      )?.title
    ).toBe('Cannot complete installation');
  });
});

describe('Agents tab return-outcome rendering', () => {
  beforeEach(() => {
    alertMock.mockReset();
    mintInstallStateMock.mockReset();
    mintInstallStateMock.mockResolvedValue({ token: 'fresh-token' });
    openAuthSessionMock.mockReset();
    openAuthSessionMock.mockResolvedValue(undefined);
    openBrowserMock.mockReset();
    openBrowserMock.mockResolvedValue(undefined);
    platformMock.OS = 'ios';
    setGitHubInstallReturnOutcome(null);
  });

  it('empty state: renders the agent list without an outcome alert', () => {
    const renderer = mountRoute();
    expect(alertMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('happy state: shows the connected alert on mount and consumes the outcome', () => {
    setGitHubInstallReturnOutcome({ kind: 'success' });
    const renderer = mountRoute();

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledWith(
      'GitHub App installed',
      'Your repositories are now connected.',
      [{ text: 'Continue' }]
    );
    expect(getGitHubInstallReturnOutcome()).toBeNull();
    act(() => {
      renderer.unmount();
    });
  });

  it('retryable state: pressing Try again mints a fresh token and reopens the flow', async () => {
    setGitHubInstallReturnOutcome({ kind: 'error', code: 'installation_failed' });
    const renderer = mountRoute();

    const tryAgain = lastAlertButtons()?.find(button => button.text === 'Try again');
    expect(tryAgain?.onPress).toBeDefined();

    act(() => {
      tryAgain?.onPress?.();
    });
    await flushMicrotasks();

    expect(mintInstallStateMock).toHaveBeenCalledWith({ returnTo: '/cloud/sessions' });
    expect(openAuthSessionMock).toHaveBeenCalledWith(
      'https://web.test/github-app?installState=fresh-token&fromApp=1'
    );
    expect(openBrowserMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('retryable state: org-scoped outcome retries with the original organizationId', async () => {
    setGitHubInstallReturnOutcome({
      kind: 'error',
      code: 'installation_failed',
      organizationId: 'org-123',
    });
    const renderer = mountRoute();

    const tryAgain = lastAlertButtons()?.find(button => button.text === 'Try again');
    expect(tryAgain?.onPress).toBeDefined();

    act(() => {
      tryAgain?.onPress?.();
    });
    await flushMicrotasks();

    expect(mintInstallStateMock).toHaveBeenCalledWith({
      organizationId: 'org-123',
      returnTo: '/cloud/sessions',
    });
    expect(openAuthSessionMock).toHaveBeenCalledWith(
      'https://web.test/github-app?organizationId=org-123&installState=fresh-token&fromApp=1'
    );
    act(() => {
      renderer.unmount();
    });
  });

  it('retryable state: mint failure keeps a working Try again in the failure alert', async () => {
    setGitHubInstallReturnOutcome({ kind: 'error', code: 'installation_failed' });
    const renderer = mountRoute();

    mintInstallStateMock.mockRejectedValueOnce(new Error('network'));
    const tryAgain = lastAlertButtons()?.find(button => button.text === 'Try again');
    act(() => {
      tryAgain?.onPress?.();
    });
    await flushMicrotasks();

    const failureButtons = lastAlertButtons();
    expect(failureButtons?.[0]?.text).toBe('Try again');
    expect(failureButtons?.[0]?.onPress).toBeDefined();

    // Pressing the failure alert retry re-mints and reopens the flow.
    act(() => {
      failureButtons?.[0]?.onPress?.();
    });
    await flushMicrotasks();
    expect(mintInstallStateMock).toHaveBeenCalledTimes(2);
    expect(openAuthSessionMock).toHaveBeenCalledWith(
      'https://web.test/github-app?installState=fresh-token&fromApp=1'
    );
    act(() => {
      renderer.unmount();
    });
  });

  it('pending state: shows the awaiting-approval alert with Done on mount', () => {
    setGitHubInstallReturnOutcome({ kind: 'pending' });
    const renderer = mountRoute();

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledWith(
      'Awaiting admin approval',
      'An organization admin must approve the installation request.',
      [{ text: 'Done' }]
    );
    expect(getGitHubInstallReturnOutcome()).toBeNull();
    act(() => {
      renderer.unmount();
    });
  });

  it('non-retryable state: shows the reason with Back and never offers retry', () => {
    setGitHubInstallReturnOutcome({ kind: 'error', code: 'not_installation_admin' });
    const renderer = mountRoute();

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledWith(
      'Cannot complete installation',
      'Only a GitHub admin of that account can connect it. Ask an organization admin to install Kilo.',
      [{ text: 'Back' }]
    );
    const backButton = lastAlertButtons()?.[0];
    expect(backButton?.text).toBe('Back');
    expect(backButton?.onPress).toBeUndefined();
    expect(getGitHubInstallReturnOutcome()).toBeNull();
    act(() => {
      renderer.unmount();
    });
  });

  it('retryable state on Android: reopening uses the browser launcher', async () => {
    setGitHubInstallReturnOutcome({ kind: 'error', code: 'installation_failed' });
    platformMock.OS = 'android';
    const renderer = mountRoute();

    const tryAgain = lastAlertButtons()?.find(button => button.text === 'Try again');

    act(() => {
      tryAgain?.onPress?.();
    });
    await flushMicrotasks();

    expect(openBrowserMock).toHaveBeenCalledWith(
      'https://web.test/github-app?installState=fresh-token&fromApp=1'
    );
    expect(openAuthSessionMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });
});

describe('Agents ActivityKit Settings recovery', () => {
  const surface: { activity: GlanceableAgentsSnapshot | null } = { activity: null };
  const sink: GlanceableSink = {
    publish: () => undefined,
    endImmediate() {
      surface.activity = null;
    },
    startOrUpdate(snapshot) {
      surface.activity = snapshot;
    },
  };
  const snapshot = buildGlanceableSnapshot({
    sessions: [{ status: 'busy' }, { status: 'question' }],
    userId: 'u1',
    organizationId: null,
    now: 1_750_000_000_000,
  });

  beforeEach(() => {
    alertMock.mockClear();
    platformMock.OS = 'ios';
    focusedRoute.focused = true;
    activityKit.denied = false;
    activityKit.available = false;
    activityKit.settingsOpen = false;
    surface.activity = null;
    appStateListeners.clear();
    setGitHubInstallReturnOutcome(null);
    _resetGlanceablePersistForTests();
    _setLastGlanceableSnapshotForTests(snapshot);
    registerGlanceableSink(sink);
  });

  afterEach(() => {
    unregisterGlanceableSink(sink);
    storage.failIdentityReadOnce = false;
  });

  function changeAppState(state: string) {
    act(() => {
      for (const listener of appStateListeners) {
        listener(state);
      }
    });
  }

  it('recovers on direct Settings return without refocusing, and never alerts', async () => {
    activityKit.denied = true;
    const renderer = mountRoute();
    await flushMicrotasks();
    expect(surface.activity).toBeNull();
    // This screen used to alert on every cold launch, asking the user to undo a
    // choice they had just made. The state now lives on the notifications
    // screen, where they went to set it.
    expect(alertMock).not.toHaveBeenCalled();

    changeAppState('background');
    changeAppState('active');
    await flushMicrotasks();
    expect(surface.activity).toBeNull();

    changeAppState('background');
    activityKit.available = true;
    changeAppState('inactive');
    await flushMicrotasks();
    expect(surface.activity).toBeNull();
    changeAppState('active');
    await flushMicrotasks();

    expect(surface.activity).toEqual(snapshot);
    expect(alertMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('retries the same snapshot after a failed Settings-return identity read', async () => {
    activityKit.denied = true;
    const renderer = mountRoute();
    await flushMicrotasks();
    alertMock.mockClear();

    changeAppState('background');
    activityKit.available = true;
    storage.failIdentityReadOnce = true;
    changeAppState('active');
    await flushMicrotasks();
    expect(surface.activity).toBeNull();

    changeAppState('background');
    changeAppState('active');
    await flushMicrotasks();

    expect(surface.activity).toEqual(snapshot);
    expect(alertMock.mock.calls).toHaveLength(0);
    act(() => {
      renderer.unmount();
    });
  });

  it.each(['blur', 'unmount'])('stops foreground recovery after route %s', async transition => {
    const renderer = mountRoute();
    if (transition === 'blur') {
      focusedRoute.focused = false;
      act(() => {
        renderer.update(createElement(AgentSessionList));
      });
    } else {
      act(() => {
        renderer.unmount();
      });
    }
    activityKit.denied = true;
    activityKit.available = true;
    changeAppState('active');
    await flushMicrotasks();

    expect(surface.activity).toBeNull();
    expect(appStateListeners.size).toBe(0);
    if (transition === 'blur') {
      act(() => {
        renderer.unmount();
      });
    }
  });
});
