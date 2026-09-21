/* eslint-disable max-lines -- the four preview-row state tests share one mock harness in this file */

// Message-previews row state contract: the switch reflects the server
// `notificationPreviews` value (no optimistic flip), a change persists through
// the mutation, a retryable failure re-renders from the unchanged server value
// with an inline retry, a UNAUTHORIZED failure disables the row with no retry,
// and an unresolved preference query renders a skeleton with no control.

import { createElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsScreen } from './notifications-screen';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { i18n } from '@/i18n';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import ur from '@/i18n/locales/ur.json';

const prefsQueryFn = vi.hoisted(() => vi.fn());
const pushTokensQueryFn = vi.hoisted(() => vi.fn());
const setPreferenceMutationFn = vi.hoisted(() => vi.fn());
const registerTokenMutationFn = vi.hoisted(() => vi.fn());
const getNotificationPermissionStatus = vi.hoisted(() => vi.fn());
const getDevicePushToken = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const registerTokenOptions = vi.hoisted(() => vi.fn());
const setPreferenceOptions = vi.hoisted(() => vi.fn());

const useKiloClawTabVisible = vi.hoisted(() => vi.fn(() => true));
vi.mock('@/lib/hooks/use-kiloclaw-tab-visible', () => ({
  useKiloClawTabVisible,
}));

const { openSettings, setLiveActivityEnabled, liveActivityEnabled, systemAllowsLiveActivities } =
  vi.hoisted(() => ({
    openSettings: vi.fn(),
    setLiveActivityEnabled: vi.fn(),
    liveActivityEnabled: vi.fn(() => true),
    systemAllowsLiveActivities: vi.fn(() => true),
  }));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  View: 'View',
  Switch: 'Switch',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Linking: { openSettings: openSettings },
  Platform: { OS: 'ios' },
}));
// The Live Activity row: the preference is SecureStore-backed and the system
// switch is a native read, so both are stubbed the way every other native
// dependency on this screen is.
vi.mock('@/lib/hooks/use-live-activity-preference', () => ({
  useLiveActivityPreference: () => ({
    liveActivityEnabled: liveActivityEnabled(),
    hasLoaded: true,
    setLiveActivityEnabled,
  }),
}));
vi.mock('@/glanceable-ios/system-switch', () => ({
  liveActivitiesAllowedBySystem: () => systemAllowsLiveActivities(),
}));
vi.mock('expo-notifications', () => ({
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  requestPermissionsAsync: vi.fn(),
}));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.4' }));
vi.mock('sonner-native', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  BellOff: 'BellOff',
  Bot: 'Bot',
  CircleCheck: 'CircleCheck',
  KeyRound: 'KeyRound',
  ListTodo: 'ListTodo',
  MessageSquare: 'MessageSquare',
  RefreshCw: 'RefreshCw',
  ShieldAlert: 'ShieldAlert',
  Smartphone: 'Smartphone',
  Sparkles: 'Sparkles',
  Wallet: 'Wallet',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'auth-token' }) }));
vi.mock('@/lib/hooks/use-app-lifecycle', () => ({ useAppLifecycle: () => ({ isActive: true }) }));
vi.mock('@/lib/hooks/use-language-preference', () => ({ getResolvedLanguage: () => 'en' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    secondaryForeground: '#000',
    mutedForeground: '#666',
    destructive: '#B0483A',
    primaryForeground: '#fff',
  }),
}));
vi.mock('@/lib/notifications', () => ({
  getNotificationPermissionStatus,
  getDevicePushToken,
  getPlatform: () => 'android',
  registerForPushNotifications: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getMyPushTokens: {
        queryOptions: () => ({ queryKey: ['getMyPushTokens'], queryFn: pushTokensQueryFn }),
      },
      getNotificationPreferences: {
        queryOptions: () => ({ queryKey: ['getNotificationPreferences'], queryFn: prefsQueryFn }),
      },
      registerPushToken: {
        mutationOptions: (opts: object) => {
          registerTokenOptions(opts);
          return {
            ...opts,
            mutationFn: registerTokenMutationFn,
            mutationKey: ['registerPushToken'],
          };
        },
      },
      setNotificationPreferences: {
        mutationOptions: (opts: object) => {
          setPreferenceOptions(opts);
          return {
            ...opts,
            mutationFn: setPreferenceMutationFn,
            mutationKey: ['setNotificationPreferences'],
          };
        },
      },
    },
  }),
}));
vi.mock('@/lib/utils', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }));

type R = ReactTestRenderer;
type I = ReactTestInstance;

function fullCapabilities(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatMessages: { available: true, unavailableReason: null },
    agentAttention: { available: true, unavailableReason: null },
    agentUpdates: { available: true, unavailableReason: null },
    sessionStatus: { available: true, unavailableReason: null },
    kiloclawActivity: { available: true, unavailableReason: null },
    balanceAlerts: { available: true, unavailableReason: null },
    securityFindings: { available: true, unavailableReason: null },
    ...overrides,
  };
}

function fullPrefs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatMessages: true,
    agentAttention: true,
    agentUpdates: true,
    sessionStatus: true,
    kiloclawActivity: true,
    balanceAlerts: true,
    securityFindings: true,
    agentPushEnabled: true,
    notificationPreviews: 'generic',
    capabilities: fullCapabilities(),
    ...overrides,
  };
}

async function renderScreen() {
  const result = await renderWithProviders(createElement(NotificationsScreen));
  return result;
}

function switchesByLabel(root: I, label: string): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Switch' &&
      n.props.accessibilityLabel === label
  );
}

function previewRetry(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      n.props.accessibilityLabel === 'Retry saving notification previews'
  );
}

function activityIndicators(root: I): I[] {
  return root.findAll(
    n => typeof n.type === 'string' && (n.type as string) === 'ActivityIndicator'
  );
}

function skeletonCount(root: I): number {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Skeleton').length;
}

function switchOnValueChange(root: I, label: string): ((value: boolean) => void) | undefined {
  const sw = switchesByLabel(root, label)[0];
  return sw ? (sw.props as { onValueChange?: (value: boolean) => void }).onValueChange : undefined;
}

function textWithChildren(root: I, content: string): I[] {
  return root.findAll(
    n => typeof n.type === 'string' && (n.type as string) === 'Text' && n.props.children === content
  );
}

// The switch renders as soon as the preference query resolves, but it stays
// disabled until the master gate settles (the device-token query is gated on
// the permission query, so it settles one cascade later). Wait for the switch
// to be enabled before driving a change, otherwise the disabled switch
// swallows the onValueChange.
async function waitForEnabledSwitch(renderer: R, label: string): Promise<void> {
  await waitFor(() => {
    const sw = switchesByLabel(renderer.root, label);
    return sw.length === 1 && sw[0]?.props.disabled === false;
  }, 200);
}

describe('NotificationsScreen message-previews row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNotificationPermissionStatus.mockResolvedValue('granted');
    getDevicePushToken.mockResolvedValue('device-token');
    pushTokensQueryFn.mockResolvedValue([{ token: 'device-token', platform: 'android' }]);
    setPreferenceMutationFn.mockResolvedValue({});
    registerTokenMutationFn.mockResolvedValue({ success: true });
  });

  it('happy: reflects the server value and persists a change', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs({ notificationPreviews: 'generic' }));
    const { renderer } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Show full previews');

    expect(switchesByLabel(renderer.root, 'Show full previews')[0]?.props.value).toBe(false);

    // A change to "full" must persist through the mutation; the refetch then
    // returns the new server value.
    prefsQueryFn.mockResolvedValue(fullPrefs({ notificationPreviews: 'full' }));
    act(() => {
      switchOnValueChange(renderer.root, 'Show full previews')?.(true);
    });
    await waitFor(() => setPreferenceMutationFn.mock.calls.length === 1);
    expect(setPreferenceMutationFn.mock.calls[0]?.[0]).toEqual({ notificationPreviews: 'full' });
    await waitFor(
      () => switchesByLabel(renderer.root, 'Show full previews')[0]?.props.value === true
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it('retryable unhappy: mutation failure re-renders the server value and shows inline retry', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs({ notificationPreviews: 'generic' }));
    setPreferenceMutationFn.mockRejectedValue({
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'boom',
    });
    const { renderer } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Show full previews');

    act(() => {
      switchOnValueChange(renderer.root, 'Show full previews')?.(true);
    });
    // pending
    expect(activityIndicators(renderer.root).length).toBe(1);
    // settled
    await waitFor(() => activityIndicators(renderer.root).length === 0);

    // The switch re-renders from the unchanged server value (still generic).
    expect(switchesByLabel(renderer.root, 'Show full previews')[0]?.props.value).toBe(false);
    expect(previewRetry(renderer.root).length).toBe(1);
    expect(toastError).toHaveBeenCalledWith('boom');
  });

  it('non-retryable unhappy: UNAUTHORIZED disables the row with no retry affordance', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs({ notificationPreviews: 'generic' }));
    setPreferenceMutationFn.mockRejectedValue({
      data: { code: 'UNAUTHORIZED' },
      message: 'Unauthorized',
    });
    const { renderer } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Show full previews');

    act(() => {
      switchOnValueChange(renderer.root, 'Show full previews')?.(true);
    });
    // pending
    expect(activityIndicators(renderer.root).length).toBe(1);
    // settled
    await waitFor(() => activityIndicators(renderer.root).length === 0);

    expect(switchesByLabel(renderer.root, 'Show full previews')[0]?.props.disabled).toBe(true);
    expect(previewRetry(renderer.root).length).toBe(0);
    expect(toastError).toHaveBeenCalledWith('Unauthorized');
  });

  it('empty: an unresolved preference query renders a skeleton and no control', async () => {
    // never resolves
    prefsQueryFn.mockReturnValue(new Promise(() => undefined));
    const { renderer } = await renderScreen();

    expect(switchesByLabel(renderer.root, 'Show full previews').length).toBe(0);
    expect(skeletonCount(renderer.root)).toBeGreaterThan(0);
  });
});

describe('NotificationsScreen KiloClaw activity row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNotificationPermissionStatus.mockResolvedValue('granted');
    getDevicePushToken.mockResolvedValue('device-token');
    pushTokensQueryFn.mockResolvedValue([{ token: 'device-token', platform: 'android' }]);
    setPreferenceMutationFn.mockResolvedValue({});
    registerTokenMutationFn.mockResolvedValue({ success: true });
  });

  it('happy: instance present shows the row and a toggle persists', async () => {
    useKiloClawTabVisible.mockReturnValue(true);
    prefsQueryFn.mockResolvedValue(fullPrefs());
    const { renderer } = await renderScreen();

    await waitForEnabledSwitch(renderer, 'KiloClaw activity');

    act(() => {
      switchOnValueChange(renderer.root, 'KiloClaw activity')?.(false);
    });
    await waitFor(() => setPreferenceMutationFn.mock.calls.length === 1);
    expect(setPreferenceMutationFn.mock.calls[0]?.[0]).toEqual({ kiloclawActivity: false });
  });

  it('empty: no instance hides the KiloClaw row and keeps the Chat messages row', async () => {
    useKiloClawTabVisible.mockReturnValue(false);
    prefsQueryFn.mockResolvedValue(fullPrefs());
    const { renderer } = await renderScreen();

    await waitFor(() => switchesByLabel(renderer.root, 'Chat messages').length === 1);
    expect(switchesByLabel(renderer.root, 'KiloClaw activity').length).toBe(0);
    expect(switchesByLabel(renderer.root, 'Chat messages').length).toBe(1);
  });

  it('retryable unhappy: prefs error shows retry and no KiloClaw row', async () => {
    useKiloClawTabVisible.mockReturnValue(false);
    prefsQueryFn.mockRejectedValue(new Error('prefs boom'));
    const { renderer } = await renderScreen();

    await waitFor(
      () =>
        renderer.root.findAll(
          n =>
            typeof n.type === 'string' &&
            (n.type as string) === 'Pressable' &&
            n.props.accessibilityLabel === 'Retry loading notification categories'
        ).length === 1
    );
    expect(switchesByLabel(renderer.root, 'KiloClaw activity').length).toBe(0);
  });

  it('empty loading: pending prefs shows skeletons and no KiloClaw switch', async () => {
    useKiloClawTabVisible.mockReturnValue(false);
    prefsQueryFn.mockReturnValue(new Promise(() => undefined));
    const { renderer } = await renderScreen();

    expect(switchesByLabel(renderer.root, 'KiloClaw activity').length).toBe(0);
    expect(skeletonCount(renderer.root)).toBeGreaterThan(0);
  });
});

describe('NotificationsScreen mutation serialization (scope.id + generation guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNotificationPermissionStatus.mockResolvedValue('granted');
    getDevicePushToken.mockResolvedValue('device-token');
    pushTokensQueryFn.mockResolvedValue([{ token: 'device-token', platform: 'android' }]);
    setPreferenceMutationFn.mockResolvedValue({});
    registerTokenMutationFn.mockResolvedValue({ success: true });
  });

  it('scopes both mutations to their fixed cache entries', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs());
    const { renderer } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Chat messages');

    expect(registerTokenOptions).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { id: 'push-tokens' } })
    );
    expect(setPreferenceOptions).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { id: 'notification-preferences' } })
    );
  });

  it('a failing older category mutation does not roll back while a newer one owns the cache', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs({ chatMessages: true, agentAttention: true }));
    const { renderer, queryClient } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Chat messages');

    const opts = setPreferenceOptions.mock.calls[0]?.[0] as
      | {
          onMutate?: (vars: Record<string, unknown>) => Promise<unknown>;
          onError?: (error: Error, vars: Record<string, unknown>, context: unknown) => void;
        }
      | undefined;
    if (!opts?.onMutate || !opts.onError) {
      throw new Error('setNotificationPreferences options not captured');
    }

    const older = await opts.onMutate({ chatMessages: false });
    const newer = await opts.onMutate({ agentAttention: false });

    // The older failure must not restore its snapshot over the newer write.
    opts.onError(new Error('boom'), { chatMessages: false }, older);
    const afterOlder = queryClient.getQueryData<Record<string, unknown>>([
      'getNotificationPreferences',
    ]);
    expect(afterOlder?.agentAttention).toBe(false);

    // The newer failure (latest generation) rolls back its own snapshot.
    opts.onError(new Error('boom'), { agentAttention: false }, newer);
    const afterNewer = queryClient.getQueryData<Record<string, unknown>>([
      'getNotificationPreferences',
    ]);
    expect(afterNewer?.agentAttention).toBe(true);
    expect(toastError).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationsScreen category availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useKiloClawTabVisible.mockReturnValue(true);
    getNotificationPermissionStatus.mockResolvedValue('granted');
    getDevicePushToken.mockResolvedValue('device-token');
    pushTokensQueryFn.mockResolvedValue([{ token: 'device-token', platform: 'android' }]);
    setPreferenceMutationFn.mockResolvedValue({});
    registerTokenMutationFn.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('happy: an available category toggle flips and persists', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs());
    const { renderer } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Chat messages');

    expect(switchesByLabel(renderer.root, 'Chat messages')[0]?.props.value).toBe(true);

    prefsQueryFn.mockResolvedValue(fullPrefs({ chatMessages: false }));
    act(() => {
      switchOnValueChange(renderer.root, 'Chat messages')?.(false);
    });
    await waitFor(() => setPreferenceMutationFn.mock.calls.length === 1);
    expect(setPreferenceMutationFn.mock.calls[0]?.[0]).toEqual({ chatMessages: false });
    await waitFor(() => switchesByLabel(renderer.root, 'Chat messages')[0]?.props.value === false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('non-retryable unhappy: an unavailable category keeps its translated description, never the response sentence', async () => {
    // The defect: the row rendered the response's `unavailableReason`, an
    // English sentence, inside a localized screen. The description must come
    // from the catalog, so a stale response string must never reach the screen.
    const staleServerReason = 'stale server prose';
    prefsQueryFn.mockResolvedValue(
      fullPrefs({
        capabilities: fullCapabilities({
          balanceAlerts: { available: false, unavailableReason: staleServerReason },
        }),
      })
    );
    const { renderer } = await renderScreen();

    // Wait for an available sibling row to be enabled first: the master gate
    // disables every row until the permission/device-token/push-token queries
    // settle, so the unavailable row is disabled from the first render. Waiting
    // on the sibling proves the gate settled and capabilities loaded.
    await waitForEnabledSwitch(renderer, 'Chat messages');

    expect(switchesByLabel(renderer.root, 'Balance alerts')[0]?.props.disabled).toBe(true);
    expect(
      textWithChildren(renderer.root, en.notifications.category.balanceAlertsUnavailable).length
    ).toBe(1);
    expect(textWithChildren(renderer.root, staleServerReason).length).toBe(0);
  });

  it('repro: an unavailable Security findings row reads in the app language, never the server prose', async () => {
    // The finding: the Arabic list showed the server's English sentence
    // 'Enable Kilo Security Agent on a scope to get security findings.' The
    // row must ignore that prose and render the catalog copy instead.
    //
    // The server reason is a sentinel because in English the catalog value IS
    // that exact sentence (asserted below), so only a distinct string can
    // prove the response's prose is never the rendered source.
    prefsQueryFn.mockResolvedValue(
      fullPrefs({
        capabilities: fullCapabilities({
          securityFindings: { available: false, unavailableReason: 'SERVER PROSE SENTINEL' },
        }),
      })
    );
    const { renderer } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Chat messages');

    // The catalog owns the finding's sentence.
    expect(i18n.t('notifications.category.securityFindingsUnavailable')).toBe(
      'Enable Kilo Security Agent on a scope to get security findings.'
    );
    // The reported defect: the row rendered the server's prose.
    expect(textWithChildren(renderer.root, 'SERVER PROSE SENTINEL').length).toBe(0);
    expect(
      textWithChildren(renderer.root, i18n.t('notifications.category.securityFindingsUnavailable'))
        .length
    ).toBe(1);
    expect(switchesByLabel(renderer.root, 'Security findings')[0]?.props.disabled).toBe(true);

    // The finding's screen: the Arabic list carries the catalog copy, resolved
    // in the active language (s2 supplies the Arabic value; until then it
    // falls back to English, so the assertion holds either way).
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    expect(
      textWithChildren(renderer.root, i18n.t('notifications.category.securityFindingsUnavailable'))
        .length
    ).toBe(1);
    expect(textWithChildren(renderer.root, 'SERVER PROSE SENTINEL').length).toBe(0);
  });

  it('non-retryable unhappy: an unavailable category reads its description from the active catalog', async () => {
    // The exact finding, on the screen that reported it: an Urdu Notifications
    // screen showed the response's English sentence on the Security findings
    // row. The row must read its copy from the catalog of the active language,
    // so a localized screen never prints the response sentence.
    // `securityFindingsUnavailable` is translated in ur.json, so this proves the
    // Urdu screen, not an English fallback.
    const serverReason = 'Enable Kilo Security Agent on a scope to get security findings.';
    prefsQueryFn.mockResolvedValue(
      fullPrefs({
        capabilities: fullCapabilities({
          securityFindings: { available: false, unavailableReason: serverReason },
        }),
      })
    );

    await i18n.changeLanguage('ur');
    const { renderer, unmount } = await renderScreen();
    try {
      await waitForEnabledSwitch(renderer, ur.notifications.channel.chat);

      expect(
        switchesByLabel(renderer.root, ur.notifications.channel.security)[0]?.props.disabled
      ).toBe(true);
      expect(
        textWithChildren(renderer.root, ur.notifications.category.securityFindingsUnavailable)
          .length
      ).toBe(1);
      expect(textWithChildren(renderer.root, serverReason).length).toBe(0);
    } finally {
      unmount();
      await i18n.changeLanguage('en');
    }
  });

  it('retryable unhappy: a category save failure rolls back the optimistic flip', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs());
    setPreferenceMutationFn.mockRejectedValue({
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'boom',
    });
    const { renderer } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Chat messages');

    act(() => {
      switchOnValueChange(renderer.root, 'Chat messages')?.(false);
    });
    await waitFor(() => setPreferenceMutationFn.mock.calls.length === 1);
    await waitFor(() => activityIndicators(renderer.root).length === 0);

    expect(switchesByLabel(renderer.root, 'Chat messages')[0]?.props.value).toBe(true);
    expect(toastError).toHaveBeenCalledWith('boom');
  });

  it('happy: a preferences response without capabilities renders every row as available', async () => {
    prefsQueryFn.mockResolvedValue({
      chatMessages: true,
      agentAttention: true,
      agentUpdates: true,
      sessionStatus: true,
      kiloclawActivity: true,
      balanceAlerts: true,
      securityFindings: true,
      agentPushEnabled: true,
      notificationPreviews: 'generic',
    });
    const { renderer } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Chat messages');

    expect(switchesByLabel(renderer.root, 'Chat messages')[0]?.props.disabled).toBe(false);
    expect(switchesByLabel(renderer.root, 'Balance alerts')[0]?.props.disabled).toBe(false);
    expect(switchesByLabel(renderer.root, 'KiloClaw activity')[0]?.props.disabled).toBe(false);
  });

  it('retryable unhappy: a capabilities query failure keeps last good availability and shows retry', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs());
    const { renderer, queryClient } = await renderScreen();
    await waitForEnabledSwitch(renderer, 'Chat messages');

    prefsQueryFn.mockRejectedValue(new Error('prefs boom'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['getNotificationPreferences'] });
    });

    await waitFor(
      () =>
        renderer.root.findAll(
          n =>
            typeof n.type === 'string' &&
            (n.type as string) === 'Pressable' &&
            n.props.accessibilityLabel === 'Retry loading notification categories'
        ).length === 1
    );
    // Last good availability is preserved: rows stay rendered and enabled.
    expect(switchesByLabel(renderer.root, 'Chat messages')[0]?.props.disabled).toBe(false);
    expect(switchesByLabel(renderer.root, 'Balance alerts')[0]?.props.disabled).toBe(false);
  });
});

describe('NotificationsScreen Arabic Security findings row', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getNotificationPermissionStatus.mockResolvedValue('granted');
    getDevicePushToken.mockResolvedValue('device-token');
    pushTokensQueryFn.mockResolvedValue([{ token: 'device-token', platform: 'android' }]);
    setPreferenceMutationFn.mockResolvedValue({});
    registerTokenMutationFn.mockResolvedValue({ success: true });
    await i18n.changeLanguage('ar');
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each(['Enable Kilo Security Agent on a scope to get security findings.', null])(
    'non-retryable empty: no enabled scope shows localized setup guidance for reason %s',
    async serverReason => {
      prefsQueryFn.mockResolvedValue(
        fullPrefs({
          capabilities: fullCapabilities({
            securityFindings: { available: false, unavailableReason: serverReason },
          }),
        })
      );
      const { renderer, unmount } = await renderScreen();
      try {
        await waitForEnabledSwitch(renderer, ar.notifications.channel.chat);

        expect(
          switchesByLabel(renderer.root, ar.notifications.channel.security)[0]?.props.disabled
        ).toBe(true);
        expect(
          textWithChildren(
            renderer.root,
            'Enable Kilo Security Agent on a scope to get security findings.'
          )
        ).toHaveLength(0);
        expect(
          textWithChildren(renderer.root, ar.notifications.category.securityFindingsUnavailable)
        ).toHaveLength(1);
        expect(textWithChildren(renderer.root, ar.common.retry)).toHaveLength(0);

        act(() => {
          switchOnValueChange(renderer.root, ar.notifications.channel.security)?.(false);
        });
        expect(setPreferenceMutationFn).not.toHaveBeenCalled();
      } finally {
        unmount();
      }
    }
  );

  it.each([fullCapabilities(), undefined])(
    'happy: available or legacy capabilities %j keep the localized subtitle and working switch',
    async capabilities => {
      prefsQueryFn.mockResolvedValue(fullPrefs({ capabilities }));
      const { renderer, unmount } = await renderScreen();
      try {
        await waitForEnabledSwitch(renderer, ar.notifications.channel.security);
        expect(
          textWithChildren(renderer.root, ar.notifications.category.securityFindingsSubtitle)
        ).toHaveLength(1);
        expect(
          textWithChildren(renderer.root, ar.notifications.category.securityFindingsUnavailable)
        ).toHaveLength(0);

        prefsQueryFn.mockResolvedValue(fullPrefs({ securityFindings: false, capabilities }));
        act(() => {
          switchOnValueChange(renderer.root, ar.notifications.channel.security)?.(false);
        });
        await waitFor(() => setPreferenceMutationFn.mock.calls.length === 1);
        expect(setPreferenceMutationFn.mock.calls[0]?.[0]).toEqual({ securityFindings: false });
        await waitFor(() => activityIndicators(renderer.root).length === 0);
        expect(
          switchesByLabel(renderer.root, ar.notifications.channel.security)[0]?.props.value
        ).toBe(false);
      } finally {
        unmount();
      }
    }
  );

  it('retryable unhappy: retrying the preferences query recovers localized setup guidance', async () => {
    prefsQueryFn.mockRejectedValue(new Error('offline'));
    const { renderer, unmount } = await renderScreen();
    try {
      await waitFor(
        () =>
          renderer.root.findAllByProps({ accessibilityLabel: ar.notifications.retryCategories })
            .length === 1
      );
      expect(switchesByLabel(renderer.root, ar.notifications.channel.security)).toHaveLength(0);
      prefsQueryFn.mockResolvedValue(
        fullPrefs({
          capabilities: fullCapabilities({
            securityFindings: { available: false, unavailableReason: null },
          }),
        })
      );
      const retry = renderer.root.findByProps({
        accessibilityLabel: ar.notifications.retryCategories,
      }).props as { onPress: () => void };
      act(() => {
        retry.onPress();
      });
      await waitForEnabledSwitch(renderer, ar.notifications.channel.chat);
      expect(
        textWithChildren(renderer.root, ar.notifications.category.securityFindingsUnavailable)
      ).toHaveLength(1);
      expect(
        renderer.root.findAllByProps({ accessibilityLabel: ar.notifications.retryCategories })
      ).toHaveLength(0);
    } finally {
      unmount();
    }
  });

  it('loading: unresolved preferences show skeletons without a Security findings control', async () => {
    prefsQueryFn.mockReturnValue(new Promise(() => undefined));
    const { renderer, unmount } = await renderScreen();
    try {
      expect(skeletonCount(renderer.root)).toBeGreaterThan(0);
      expect(switchesByLabel(renderer.root, ar.notifications.channel.security)).toHaveLength(0);
      expect(
        textWithChildren(renderer.root, ar.notifications.category.securityFindingsUnavailable)
      ).toHaveLength(0);
    } finally {
      unmount();
    }
  });
});
