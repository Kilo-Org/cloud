/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */
/* eslint-disable max-lines -- the four preview-row state tests share one mock harness in this file */

// Message-previews row state contract: the switch reflects the server
// `notificationPreviews` value (no optimistic flip), a change persists through
// the mutation, a retryable failure re-renders from the unchanged server value
// with an inline retry, a UNAUTHORIZED failure disables the row with no retry,
// and an unresolved preference query renders a skeleton with no control.

import { createElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsScreen } from './notifications-screen';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const prefsQueryFn = vi.hoisted(() => vi.fn());
const pushTokensQueryFn = vi.hoisted(() => vi.fn());
const setPreferenceMutationFn = vi.hoisted(() => vi.fn());
const registerTokenMutationFn = vi.hoisted(() => vi.fn());
const getNotificationPermissionStatus = vi.hoisted(() => vi.fn());
const getDevicePushToken = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

const useKiloClawTabVisible = vi.hoisted(() => vi.fn(() => true));
vi.mock('@/lib/hooks/use-kiloclaw-tab-visible', () => ({
  useKiloClawTabVisible,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Switch: 'Switch',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Linking: { openSettings: vi.fn() },
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
        mutationOptions: (opts: object) => ({
          ...opts,
          mutationFn: registerTokenMutationFn,
          mutationKey: ['registerPushToken'],
        }),
      },
      setNotificationPreferences: {
        mutationOptions: (opts: object) => ({
          ...opts,
          mutationFn: setPreferenceMutationFn,
          mutationKey: ['setNotificationPreferences'],
        }),
      },
    },
  }),
}));
vi.mock('@/lib/utils', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }));

type R = ReactTestRenderer;
type I = ReactTestInstance;

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
    ...overrides,
  };
}

async function renderScreen() {
  const result = await renderWithProviders(createElement(NotificationsScreen));
  return result;
}

function previewSwitches(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Switch' &&
      n.props.accessibilityLabel === 'Show full previews'
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

function kiloclawSwitches(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Switch' &&
      n.props.accessibilityLabel === 'KiloClaw activity'
  );
}

function chatMessagesSwitches(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Switch' &&
      n.props.accessibilityLabel === 'Chat messages'
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

function previewSwitchOnValueChange(root: I): ((value: boolean) => void) | undefined {
  const sw = previewSwitches(root)[0];
  return sw ? (sw.props as { onValueChange?: (value: boolean) => void }).onValueChange : undefined;
}

function kiloclawSwitchOnValueChange(root: I): ((value: boolean) => void) | undefined {
  const sw = kiloclawSwitches(root)[0];
  return sw ? (sw.props as { onValueChange?: (value: boolean) => void }).onValueChange : undefined;
}

// The preview switch renders as soon as the preference query resolves, but it
// stays disabled until the master gate settles (the device-token query is
// gated on the permission query, so it settles one cascade later). Wait for the
// switch to be enabled before driving a change, otherwise the disabled switch
// swallows the onValueChange.
async function waitForEnabledPreviewSwitch(renderer: R): Promise<void> {
  await waitFor(() => {
    const sw = previewSwitches(renderer.root);
    return sw.length === 1 && sw[0]?.props.disabled === false;
  }, 200);
}

// The KiloClaw switch renders as soon as the preference query resolves, but it
// stays disabled until the master gate settles (the device-token query is
// gated on the permission query, so it settles one cascade later). Wait for the
// switch to be enabled before driving a change, otherwise the disabled switch
// swallows the onValueChange.
async function waitForEnabledKiloClawSwitch(renderer: R): Promise<void> {
  await waitFor(() => {
    const sw = kiloclawSwitches(renderer.root);
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
    await waitForEnabledPreviewSwitch(renderer);

    expect(previewSwitches(renderer.root)[0]?.props.value).toBe(false);

    // A change to "full" must persist through the mutation; the refetch then
    // returns the new server value.
    prefsQueryFn.mockResolvedValue(fullPrefs({ notificationPreviews: 'full' }));
    act(() => {
      previewSwitchOnValueChange(renderer.root)?.(true);
    });
    await waitFor(() => setPreferenceMutationFn.mock.calls.length === 1);
    expect(setPreferenceMutationFn.mock.calls[0]?.[0]).toEqual({ notificationPreviews: 'full' });
    await waitFor(() => previewSwitches(renderer.root)[0]?.props.value === true);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('retryable unhappy: mutation failure re-renders the server value and shows inline retry', async () => {
    prefsQueryFn.mockResolvedValue(fullPrefs({ notificationPreviews: 'generic' }));
    setPreferenceMutationFn.mockRejectedValue({
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'boom',
    });
    const { renderer } = await renderScreen();
    await waitForEnabledPreviewSwitch(renderer);

    act(() => {
      previewSwitchOnValueChange(renderer.root)?.(true);
    });
    // pending
    expect(activityIndicators(renderer.root).length).toBe(1);
    // settled
    await waitFor(() => activityIndicators(renderer.root).length === 0);

    // The switch re-renders from the unchanged server value (still generic).
    expect(previewSwitches(renderer.root)[0]?.props.value).toBe(false);
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
    await waitForEnabledPreviewSwitch(renderer);

    act(() => {
      previewSwitchOnValueChange(renderer.root)?.(true);
    });
    // pending
    expect(activityIndicators(renderer.root).length).toBe(1);
    // settled
    await waitFor(() => activityIndicators(renderer.root).length === 0);

    expect(previewSwitches(renderer.root)[0]?.props.disabled).toBe(true);
    expect(previewRetry(renderer.root).length).toBe(0);
    expect(toastError).toHaveBeenCalledWith('Unauthorized');
  });

  it('empty: an unresolved preference query renders a skeleton and no control', async () => {
    // never resolves
    prefsQueryFn.mockReturnValue(new Promise(() => undefined));
    const { renderer } = await renderScreen();

    expect(previewSwitches(renderer.root).length).toBe(0);
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

    await waitForEnabledKiloClawSwitch(renderer);

    act(() => {
      kiloclawSwitchOnValueChange(renderer.root)?.(false);
    });
    await waitFor(() => setPreferenceMutationFn.mock.calls.length === 1);
    expect(setPreferenceMutationFn.mock.calls[0]?.[0]).toEqual({ kiloclawActivity: false });
  });

  it('empty: no instance hides the KiloClaw row and keeps the Chat messages row', async () => {
    useKiloClawTabVisible.mockReturnValue(false);
    prefsQueryFn.mockResolvedValue(fullPrefs());
    const { renderer } = await renderScreen();

    await waitFor(() => chatMessagesSwitches(renderer.root).length === 1);
    expect(kiloclawSwitches(renderer.root).length).toBe(0);
    expect(chatMessagesSwitches(renderer.root).length).toBe(1);
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
    expect(kiloclawSwitches(renderer.root).length).toBe(0);
  });

  it('empty loading: pending prefs shows skeletons and no KiloClaw switch', async () => {
    useKiloClawTabVisible.mockReturnValue(false);
    prefsQueryFn.mockReturnValue(new Promise(() => undefined));
    const { renderer } = await renderScreen();

    expect(kiloclawSwitches(renderer.root).length).toBe(0);
    expect(skeletonCount(renderer.root)).toBeGreaterThan(0);
  });
});
