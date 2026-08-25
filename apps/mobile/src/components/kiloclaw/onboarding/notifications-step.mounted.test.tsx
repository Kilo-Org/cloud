/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Push-registration payload contract for the KiloClaw onboarding step: the
// row it writes must carry the active language and the app version. A null
// locale sends English push copy, and a null app_version drops the Android
// channel id, so omitting either field breaks a device enrolled from here.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsStep } from './notifications-step';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const registerTokenMutationFn = vi.hoisted(() => vi.fn());
const getNotificationPermissionStatus = vi.hoisted(() => vi.fn());
const registerForPushNotifications = vi.hoisted(() => vi.fn());
const getResolvedLanguage = vi.hoisted(() => vi.fn());

// One stable `t` and one stable result object: the step's
// `completeRegistration` callback depends on `t`, so a fresh function per
// render would re-fire the mount effect forever.
const translation = { t: (key: string) => key };
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Linking: { openSettings: vi.fn() },
}));
vi.mock('expo-secure-store', () => ({ setItemAsync: vi.fn() }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.5' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: () => null }));
vi.mock('@/components/kiloclaw/bot-avatar', () => ({ BotAvatar: () => null }));
vi.mock('@/lib/hooks/use-app-lifecycle', () => ({ useAppLifecycle: () => ({ isActive: true }) }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    mutedForeground: '#666666',
    primaryForeground: '#ffffff',
  }),
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({ getResolvedLanguage }));
vi.mock('@/lib/notifications', () => ({
  getNotificationPermissionStatus,
  getPlatform: () => 'android',
  registerForPushNotifications,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      registerPushToken: {
        mutationOptions: () => ({ mutationFn: registerTokenMutationFn }),
      },
    },
  }),
}));

describe('NotificationsStep push registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNotificationPermissionStatus.mockResolvedValue('granted');
    registerForPushNotifications.mockResolvedValue('push-1');
    getResolvedLanguage.mockReturnValue('de');
    registerTokenMutationFn.mockResolvedValue({ success: true });
  });

  it('registers the token with the active locale and the app version', async () => {
    await renderWithProviders(
      createElement(NotificationsStep, { onComplete: vi.fn<() => void>(), botIdentity: null })
    );

    // The harness `waitFor` takes a boolean predicate, not an assertion.
    await waitFor(() => registerTokenMutationFn.mock.calls.length > 0);
    // TanStack Query passes a context object after the variables.
    expect(registerTokenMutationFn.mock.calls[0]?.[0]).toEqual({
      token: 'push-1',
      platform: 'android',
      appVersion: '1.0.5',
      locale: 'de',
    });
  });
});
