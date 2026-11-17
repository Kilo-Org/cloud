import { createElement, type FunctionComponent } from 'react';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import {
  BriefingNotificationCategoryRow,
  BriefingNotificationToggle,
} from './briefing-notification-toggle';

const mutate = vi.hoisted(() => vi.fn());
const preferencesRead = vi.hoisted(() => ({ isError: false, refetch: vi.fn() }));

vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'de', resolvedLanguage: 'de' },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate, isPending: false }),
  useQueryClient: () => ({}),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/ui/icons', () => ({ Newspaper: 'Newspaper' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/agent-briefing', () => ({
  useBriefingPreferences: () => ({
    data: {
      notificationsEnabled: false,
      timezone: 'Europe/Berlin',
      nightStart: '21:00',
      morningStart: '07:00',
      morningEnd: '11:00',
      language: 'en',
    },
    isError: preferencesRead.isError,
    refetch: preferencesRead.refetch,
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      updatePreferences: { mutationOptions: () => ({}) },
      preferences: { pathKey: () => ['agentBriefing', 'preferences'] },
    },
  }),
}));

function mount<P extends object>(component: FunctionComponent<P>, props: P) {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(createElement(component, props));
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Notification settings are not mounted');
  }
  return mounted;
}

function categoryRowOf(mounted: TestRenderer.ReactTestRenderer) {
  return mounted.root.find(node => (node.type as string) === 'PreferenceRow');
}

it('shows the device-notifications link from Briefing settings', () => {
  const mounted = mount(BriefingNotificationToggle, {});

  expect(mounted.root.findAll(node => (node.type as string) === 'Button')).toHaveLength(1);

  act(() => {
    mounted.unmount();
  });
});

it('retries the brief preferences when their read fails', () => {
  preferencesRead.isError = true;
  preferencesRead.refetch.mockClear();
  const mounted = mount(BriefingNotificationToggle, {});

  // The failed read leaves the switch unavailable and offers its own retry:
  // the setting is not saved from here, so the retry is the only action.
  const retry = mounted.root.find(
    node =>
      (node.type as string) === 'Button' &&
      node.findAll(child => child.props.children === 'common.retry').length > 0
  );
  act(() => {
    (retry.props.onPress as () => void)();
  });
  expect(preferencesRead.refetch).toHaveBeenCalledTimes(1);

  act(() => {
    mounted.unmount();
  });
  preferencesRead.isError = false;
});

it('saves the brief preference from its Notifications category row', () => {
  mutate.mockClear();
  const mounted = mount(BriefingNotificationCategoryRow, { disabled: false });

  // The row is the shared switch row: no surface, no divider, no second action.
  expect(mounted.root.findAll(node => (node.type as string) === 'Button')).toHaveLength(0);
  const row = categoryRowOf(mounted);
  expect(row.props.icon).toBe('Newspaper');
  expect(row.props.disabled).toBe(false);
  act(() => {
    (row.props.onValueChange as (value: boolean) => void)(true);
  });
  expect(mutate).toHaveBeenCalledWith({
    notificationsEnabled: true,
    timezone: 'Europe/Berlin',
    language: 'de',
    nightStart: '21:00',
    morningStart: '07:00',
    morningEnd: '11:00',
  });

  act(() => {
    mounted.unmount();
  });
});

it('disables the category row with the device-notification gate', () => {
  mutate.mockClear();
  const mounted = mount(BriefingNotificationCategoryRow, { disabled: true });

  // The gate travels to the primitive, which owns the disabled switch.
  expect(categoryRowOf(mounted).props.disabled).toBe(true);
  expect(mutate).not.toHaveBeenCalled();

  act(() => {
    mounted.unmount();
  });
});
