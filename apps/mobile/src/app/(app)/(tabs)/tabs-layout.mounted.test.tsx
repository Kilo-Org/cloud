// Named `tabs-layout`, never `_layout.*`: expo-router's route parser reads the
// first dot-separated part of a filename, so `_layout.mounted.test.tsx` counts
// as the layout for this directory. The typed-routes generator walks the
// filesystem directly (not Metro's test blocklist), so that stray layout
// swallowed the whole `(tabs)` subtree and every tab route vanished from `Href`.
//
// The tab bar yields the bottom band to the IME: the shared `screenOptions`
// must carry `tabBarHideOnKeyboard: true` so the absolutely-positioned bar
// hides while the keyboard is up (its labels and the empty-state second line
// otherwise sit under the IME strip). The option lives on the same object that
// carries the existing `tabBarStyle`, so every tab and both platforms share it.

import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TabsLayout from '@/app/(app)/(tabs)/_layout';
import { i18n } from '@/i18n';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';
import { renderWithProviders } from '@/test/render-with-providers';

type CapturedTabsOptions = Record<string, unknown>;

const tabsRenders = vi.hoisted(() => ({ list: [] as { screenOptions?: CapturedTabsOptions }[] }));
// The centered-state band the tabs navigator hands its screens. It must be the
// tab bar's own height: reserving the scroll-content gap as well shrank the band
// below the empty state's height in a short landscape window and parked its
// second line and action behind the bar (landscape spot defect e8).
const surfaceInsets = vi.hoisted(() => ({ list: [] as { bottomInset?: number }[] }));

vi.mock('expo-router', () => {
  const Tabs = Object.assign(
    (props: { screenOptions?: CapturedTabsOptions }) => {
      tabsRenders.list.push(props);
      return null;
    },
    { Screen: () => null }
  );
  return {
    useRouter: () => ({ replace: vi.fn(), navigate: vi.fn(), push: vi.fn() }),
    usePathname: () => '/(app)/(tabs)/(0_home)',
    useSegments: () => ['(app)', '(tabs)', '(0_home)'],
    Tabs,
  };
});
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1, width: 800, height: 360 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 24, top: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/centered-state-surface', async () => {
  const react = await import('react');
  return {
    StateSurfaceInsets: (props: { children?: ReactNode; bottomInset?: number }) => {
      surfaceInsets.list.push({ bottomInset: props.bottomInset });
      return react.createElement(react.Fragment, null, props.children);
    },
  };
});
vi.mock('@/components/ui/blur-bar', () => ({ BlurBar: 'BlurBar' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  House: 'House',
  MessageCircle: 'MessageCircle',
  MessageSquare: 'MessageSquare',
  UserRound: 'UserRound',
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_QUICK_CHAT: 'mobile-quick-chat',
  useFeatureFlag: () => false,
}));
vi.mock('@/lib/app-actions/use-pending-app-action', () => ({
  usePendingAppAction: () => undefined,
}));
vi.mock('@/lib/finding-detail-back', () => ({
  PROFILE_TAB_ROOT: '/(app)/(tabs)/(3_profile)',
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useLiveAgentSessions: () => ({ activeSessions: [], isLoading: false, isError: false }),
}));
vi.mock('@/lib/hooks/use-kiloclaw-tab-visible', () => ({
  useKiloClawTabVisible: () => false,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#888888' }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: 'org-1',
    isLoaded: true,
    error: null,
    retry: vi.fn(),
    setOrganizationId: vi.fn(),
  }),
}));

/** The `screenOptions` object captured from the most recent `Tabs` render. */
function latestScreenOptions(): CapturedTabsOptions | undefined {
  return tabsRenders.list.at(-1)?.screenOptions;
}

describe('TabsLayout screen options', () => {
  beforeEach(() => {
    tabsRenders.list.length = 0;
    surfaceInsets.list.length = 0;
  });

  it('hides the tab bar while the keyboard is up, on the shared option object', async () => {
    await renderWithProviders(createElement(TabsLayout));

    expect(i18n.isInitialized).toBe(true);
    const screenOptions = latestScreenOptions();
    expect(screenOptions).toBeDefined();
    expect(screenOptions?.tabBarHideOnKeyboard).toBe(true);
    // The same shared object keeps the bar's absolute placement, so hiding it
    // moves no surrounding layout and dismissal restores it in place.
    const tabBarStyle = screenOptions?.tabBarStyle as {
      display?: string;
      position?: string;
      height?: unknown;
    };
    expect(tabBarStyle).toMatchObject({ display: 'flex', position: 'absolute' });
    expect(typeof tabBarStyle.height).toBe('number');
    // Labels stay configured, so the bar comes back whole when the IME is gone.
    expect(screenOptions?.tabBarShowLabel).toBe(true);
  });

  it('ends the centered-state band at the tab bar, not at the scroll gap above it', async () => {
    await renderWithProviders(createElement(TabsLayout));

    // The harness reports a 24pt bottom safe inset on iOS, so the bar is 74pt.
    const tabBarHeight = getEffectiveTabBarHeight({
      bottomInset: 24,
      platform: 'ios',
      fontScale: 1,
    });
    expect(tabBarHeight).toBe(74);
    expect(surfaceInsets.list.at(-1)?.bottomInset).toBe(tabBarHeight);
  });
});
