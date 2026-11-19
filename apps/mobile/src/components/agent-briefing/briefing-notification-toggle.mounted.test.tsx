import { createElement, type FunctionComponent } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import {
  BriefingNotificationCategoryRow,
  BriefingNotificationToggle,
} from './briefing-notification-toggle';

const mutate = vi.hoisted(() => vi.fn());
const preferencesRead = vi.hoisted(() => ({ isError: false, refetch: vi.fn() }));
const push = vi.hoisted(() => vi.fn());

const network = vi.hoisted(() => ({ offline: false }));

const preferencesState = vi.hoisted(() => {
  const base = {
    notificationsEnabled: false,
    timezone: 'Europe/Berlin',
    nightStart: '21:00',
    morningStart: '07:00',
    morningEnd: '11:00',
    language: 'en',
  };
  return {
    base,
    current: {
      data: base as typeof base | undefined,
      isError: false,
      isPending: false,
      refetch: () => Promise.resolve(),
    },
  };
});

/** The settled read: preferences arrived, nothing pending, no error. */
function settlePreferences(): void {
  preferencesState.current = {
    data: { ...preferencesState.base },
    isError: false,
    isPending: false,
    refetch: () => Promise.resolve(),
  };
}

/** The first load: no cached preferences, the query still pending. */
function beginPreferencesLoad(): void {
  preferencesState.current = {
    data: undefined,
    isError: false,
    isPending: true,
    refetch: () => Promise.resolve(),
  };
}

beforeEach(settlePreferences);
afterEach(() => {
  network.offline = false;
});

vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));
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
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/ui/row-group', () => ({ RowGroup: 'RowGroup' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/icons', () => ({ Bell: 'Bell', Newspaper: 'Newspaper' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/lib/agent-briefing', () => ({
  useBriefingPreferences: () => preferencesState.current,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useOfflineBannerState: () => network.offline,
}));
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

function rowSkeletonOf(mounted: TestRenderer.ReactTestRenderer) {
  return mounted.root.find(node => (node.type as string) === 'RowSkeleton');
}

it('shows the device-notifications link from Briefing settings', () => {
  push.mockClear();
  const mounted = mount(BriefingNotificationToggle, {});

  // The permission sentence is the row's subtitle, not a bold centered label:
  // the row names where it leads and carries the chevron every destination row
  // has.
  const link = mounted.root.find(node => (node.type as string) === 'ConfigureRow');
  expect(link.props.title).toBe('common.notifications');
  expect(link.props.subtitle).toBe('agentBriefing.notificationPermission');
  act(() => {
    (link.props.onPress as () => void)();
  });
  expect(push).toHaveBeenCalledWith('/(app)/notifications');

  act(() => {
    mounted.unmount();
  });
});

it('retries the brief preferences when their read fails', () => {
  preferencesState.current = {
    data: undefined,
    isError: true,
    isPending: false,
    refetch: preferencesRead.refetch,
  };
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

function nodesOfType(mounted: TestRenderer.ReactTestRenderer, type: string) {
  return mounted.root.findAll(node => (node.type as string) === type);
}

it('shows the toggle placeholder instead of the switch while preferences load', () => {
  beginPreferencesLoad();

  const standalone = mount(BriefingNotificationToggle, {});
  // The switch row is the shared skeleton with its switch slot, so the row the
  // value lands in keeps the height already on screen.
  const standaloneSkeleton = rowSkeletonOf(standalone);
  expect(standaloneSkeleton.props.subtitle).toBe(true);
  expect(standaloneSkeleton.props.trailing).toBe('switch');
  expect(nodesOfType(standalone, 'PreferenceRow')).toHaveLength(0);
  expect(nodesOfType(standalone, 'ConfigureRow')).toHaveLength(1);
  act(() => {
    standalone.unmount();
  });

  // The row is the shared skeleton, so assistive tech never meets a switch whose
  // value nothing has read yet.
  const row = mount(BriefingNotificationCategoryRow, { disabled: false });
  const skeleton = rowSkeletonOf(row);
  expect(skeleton.props.tile).toBe(true);
  expect(skeleton.props.subtitle).toBe(true);
  expect(skeleton.props.trailing).toBe('switch');
  expect(nodesOfType(row, 'PreferenceRow')).toHaveLength(0);
  expect(nodesOfType(row, 'Switch')).toHaveLength(0);
  act(() => {
    row.unmount();
  });
});

it('swaps the toggle placeholder for the switch once preferences arrive', () => {
  beginPreferencesLoad();
  const mounted = mount(BriefingNotificationCategoryRow, { disabled: false });
  expect(nodesOfType(mounted, 'RowSkeleton')).toHaveLength(1);

  settlePreferences();
  act(() => {
    mounted.update(createElement(BriefingNotificationCategoryRow, { disabled: false }));
  });

  expect(nodesOfType(mounted, 'RowSkeleton')).toHaveLength(0);
  const primitive = categoryRowOf(mounted);
  expect(primitive.props.busy).toBe(false);
  expect(primitive.props.value).toBe(false);

  act(() => {
    mounted.unmount();
  });
});

it('renders the loading category row as the shared row skeleton', () => {
  beginPreferencesLoad();
  const mounted = mount(BriefingNotificationCategoryRow, { disabled: false });

  expect(nodesOfType(mounted, 'RowSkeleton')).toHaveLength(1);
  expect(nodesOfType(mounted, 'PreferenceRow')).toHaveLength(0);

  act(() => {
    mounted.unmount();
  });
});

it('does not hold the loading placeholder while offline', () => {
  // An offline-paused read never settles, so a paused row must not pose as a
  // load in progress forever: offline falls back to the disabled switch slot.
  beginPreferencesLoad();
  network.offline = true;
  const mounted = mount(BriefingNotificationCategoryRow, { disabled: false });

  const primitive = categoryRowOf(mounted);
  expect(primitive.props.busy).toBe(false);
  expect(primitive.props.disabled).toBe(true);

  act(() => {
    mounted.unmount();
  });
});
